import { Context, ROOT_CONTEXT, Span, SpanKind, context, trace } from "@opentelemetry/api";
import {
  MachinePreset,
  ProdTaskRunExecution,
  ProdTaskRunExecutionPayload,
  TaskRunError,
  TaskRunErrorCodes,
  TaskRunExecution,
  TaskRunExecutionLazyAttemptPayload,
  TaskRunExecutionResult,
  TaskRunFailedExecutionResult,
  TaskRunSuccessfulExecutionResult,
  parsePacket,
  serverWebsocketMessages,
} from "@trigger.dev/core/v3";
import { ZodMessageSender } from "@trigger.dev/core/v3/zodMessageHandler";
import {
  BackgroundWorker,
  BackgroundWorkerTask,
  Prisma,
  RuntimeEnvironment,
  TaskRun,
  TaskRunStatus,
} from "@trigger.dev/database";
import { z } from "zod";
import { $replica, prisma } from "~/db.server";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";
import { marqs, sanitizeQueueName } from "~/v3/marqs/index.server";
import { resolveVariablesForEnvironment } from "../environmentVariables/environmentVariablesRepository.server";
import { FailedTaskRunService } from "../failedTaskRun.server";
import { generateFriendlyId } from "../friendlyIdentifiers";
import { socketIo } from "../handleSocketIo.server";
import {
  findCurrentWorkerDeployment,
  getWorkerDeploymentFromWorker,
  getWorkerDeploymentFromWorkerTask,
} from "../models/workerDeployment.server";
import { CrashTaskRunService } from "../services/crashTaskRun.server";
import { CreateTaskRunAttemptService } from "../services/createTaskRunAttempt.server";
import { RestoreCheckpointService } from "../services/restoreCheckpoint.server";
import { SEMINTATTRS_FORCE_RECORDING, tracer } from "../tracer.server";
import { generateJWTTokenForEnvironment } from "~/services/apiAuth.server";
import { EnvironmentVariable } from "../environmentVariables/repository";
import { machinePresetFromConfig, machinePresetFromRun } from "../machinePresets.server";
import { env } from "~/env.server";
import {
  FINAL_ATTEMPT_STATUSES,
  FINAL_RUN_STATUSES,
  isFinalAttemptStatus,
  isFinalRunStatus,
} from "../taskStatus";
import { getMaxDuration } from "../utils/maxDuration";

const WithTraceContext = z.object({
  traceparent: z.string().optional(),
  tracestate: z.string().optional(),
});

export const SharedQueueMessageBody = z.discriminatedUnion("type", [
  WithTraceContext.extend({
    type: z.literal("EXECUTE"),
    taskIdentifier: z.string(),
    checkpointEventId: z.string().optional(),
    retryCheckpointsDisabled: z.boolean().optional(),
  }),
  WithTraceContext.extend({
    type: z.literal("RESUME"),
    completedAttemptIds: z.string().array(),
    resumableAttemptId: z.string(),
    checkpointEventId: z.string().optional(),
  }),
  WithTraceContext.extend({
    type: z.literal("RESUME_AFTER_DURATION"),
    resumableAttemptId: z.string(),
    checkpointEventId: z.string(),
  }),
  WithTraceContext.extend({
    type: z.literal("FAIL"),
    reason: z.string(),
  }),
]);

export type SharedQueueMessageBody = z.infer<typeof SharedQueueMessageBody>;

type BackgroundWorkerWithTasks = BackgroundWorker & { tasks: BackgroundWorkerTask[] };

export type SharedQueueConsumerOptions = {
  maximumItemsPerTrace?: number;
  traceTimeoutSeconds?: number;
  nextTickInterval?: number;
  interval?: number;
};

export class SharedQueueConsumer {
  private _backgroundWorkers: Map<string, BackgroundWorkerWithTasks> = new Map();
  private _deprecatedWorkers: Map<string, BackgroundWorkerWithTasks> = new Map();
  private _enabled = false;
  private _options: Required<SharedQueueConsumerOptions>;
  private _perTraceCountdown: number | undefined;
  private _lastNewTrace: Date | undefined;
  private _currentSpanContext: Context | undefined;
  private _taskFailures: number = 0;
  private _taskSuccesses: number = 0;
  private _currentSpan: Span | undefined;
  private _endSpanInNextIteration = false;
  private _tasks = sharedQueueTasks;
  private _id: string;

  constructor(
    private _sender: ZodMessageSender<typeof serverWebsocketMessages>,
    options: SharedQueueConsumerOptions = {}
  ) {
    this._options = {
      maximumItemsPerTrace: options.maximumItemsPerTrace ?? 500,
      traceTimeoutSeconds: options.traceTimeoutSeconds ?? 10,
      nextTickInterval: options.nextTickInterval ?? 1000, // 1 second
      interval: options.interval ?? 100, // 100ms
    };

    this._id = generateFriendlyId("shared-queue", 6);
  }

  // This method is called when a background worker is deprecated and will no longer be used unless a run is locked to it
  public async deprecateBackgroundWorker(id: string) {
    const backgroundWorker = this._backgroundWorkers.get(id);

    if (!backgroundWorker) {
      return;
    }

    this._deprecatedWorkers.set(id, backgroundWorker);
    this._backgroundWorkers.delete(id);
  }

  public async registerBackgroundWorker(id: string, envId?: string) {
    if (!envId) {
      logger.error("Environment ID is required for background worker registration", {
        backgroundWorkerId: id,
      });
      return;
    }

    const backgroundWorker = await prisma.backgroundWorker.findUnique({
      where: {
        friendlyId: id,
        runtimeEnvironmentId: envId,
      },
      include: {
        tasks: true,
      },
    });

    if (!backgroundWorker) {
      return;
    }

    this._backgroundWorkers.set(backgroundWorker.id, backgroundWorker);

    logger.debug("Registered background worker", { backgroundWorker: backgroundWorker.id });

    // Start reading from the queue if we haven't already
    this.#enable();
  }

  public async start() {
    this.#enable();
  }

  public async stop(reason: string = "Provider disconnected") {
    if (!this._enabled) {
      return;
    }

    logger.debug("Stopping shared queue consumer");
    this._enabled = false;

    if (this._currentSpan) {
      this._currentSpan.end();
    }
  }

  #enable() {
    if (this._enabled) {
      return;
    }

    this._enabled = true;
    this._perTraceCountdown = this._options.maximumItemsPerTrace;
    this._lastNewTrace = new Date();
    this._taskFailures = 0;
    this._taskSuccesses = 0;

    this.#doWork().finally(() => {});
  }

  #endCurrentSpan() {
    if (this._currentSpan) {
      this._currentSpan.setAttribute("tasks.period.failures", this._taskFailures);
      this._currentSpan.setAttribute("tasks.period.successes", this._taskSuccesses);
      this._currentSpan.end();
    }
  }

  async #doWork() {
    if (!this._enabled) {
      this.#endCurrentSpan();
      return;
    }

    // Check if the trace has expired
    if (
      this._perTraceCountdown === 0 ||
      Date.now() - this._lastNewTrace!.getTime() > this._options.traceTimeoutSeconds * 1000 ||
      this._currentSpanContext === undefined ||
      this._endSpanInNextIteration
    ) {
      this.#endCurrentSpan();

      // Create a new trace
      this._currentSpan = tracer.startSpan(
        "SharedQueueConsumer.doWork()",
        {
          kind: SpanKind.CONSUMER,
          attributes: {
            [SEMINTATTRS_FORCE_RECORDING]: true,
          },
        },
        ROOT_CONTEXT
      );

      // Get the span trace context
      this._currentSpanContext = trace.setSpan(ROOT_CONTEXT, this._currentSpan);

      this._perTraceCountdown = this._options.maximumItemsPerTrace;
      this._lastNewTrace = new Date();
      this._taskFailures = 0;
      this._taskSuccesses = 0;
      this._endSpanInNextIteration = false;
    }

    return context.with(this._currentSpanContext ?? ROOT_CONTEXT, async () => {
      await this.#doWorkInternal();
      this._perTraceCountdown = this._perTraceCountdown! - 1;
    });
  }

  async #doWorkInternal() {
    // Attempt to dequeue a message from the shared queue
    // If no message is available, reschedule the worker to run again in 1 second
    // If a message is available, find the BackgroundWorkerTask that matches the message's taskIdentifier
    // If no matching task is found, nack the message and reschedule the worker to run again in 1 second
    // If the matching task is found, create the task attempt and lock the task run, then send the task run to the client
    // Store the message as a processing message
    // If the websocket connection disconnects before the task run is completed, nack the message
    // When the task run completes, ack the message
    // Using a heartbeat mechanism, if the client keeps responding with a heartbeat, we'll keep the message processing and increase the visibility timeout.

    const message = await marqs?.dequeueMessageInSharedQueue(this._id);

    if (!message) {
      this.#doMoreWork(this._options.nextTickInterval);
      return;
    }

    logger.log("dequeueMessageInSharedQueue()", { queueMessage: message });

    const messageBody = SharedQueueMessageBody.safeParse(message.data);

    if (!messageBody.success) {
      logger.error("Failed to parse message", {
        queueMessage: message.data,
        error: messageBody.error,
      });

      await this.#ackAndDoMoreWork(message.messageId);
      return;
    }

    // TODO: For every ACK, decide what should be done with the existing run and attempts. Make sure to check the current statuses first.

    switch (messageBody.data.type) {
      // MARK: EXECUTE
      case "EXECUTE": {
        const existingTaskRun = await prisma.taskRun.findUnique({
          where: {
            id: message.messageId,
          },
        });

        if (!existingTaskRun) {
          logger.error("No existing task run", {
            queueMessage: message.data,
            messageId: message.messageId,
          });

          // INFO: There used to be a race condition where tasks could be triggered, but execute messages could be dequeued before the run finished being created in the DB
          //       This should not be happening anymore. In case it does, consider reqeueuing here with a brief delay while limiting total retries.

          await this.#ackAndDoMoreWork(message.messageId);
          return;
        }

        const retryingFromCheckpoint = !!messageBody.data.checkpointEventId;

        const EXECUTABLE_RUN_STATUSES = {
          fromCheckpoint: ["WAITING_TO_RESUME"] satisfies TaskRunStatus[],
          withoutCheckpoint: ["PENDING", "RETRYING_AFTER_FAILURE"] satisfies TaskRunStatus[],
        };

        if (
          (retryingFromCheckpoint &&
            !EXECUTABLE_RUN_STATUSES.fromCheckpoint.includes(existingTaskRun.status)) ||
          (!retryingFromCheckpoint &&
            !EXECUTABLE_RUN_STATUSES.withoutCheckpoint.includes(existingTaskRun.status))
        ) {
          logger.error("Task run has invalid status for execution. Going to ack", {
            queueMessage: message.data,
            messageId: message.messageId,
            taskRun: existingTaskRun.id,
            status: existingTaskRun.status,
            retryingFromCheckpoint,
          });

          await this.#ackAndDoMoreWork(message.messageId);
          return;
        }

        // Check if the task run is locked to a specific worker, if not, use the current worker deployment
        const deployment = existingTaskRun.lockedById
          ? await getWorkerDeploymentFromWorkerTask(existingTaskRun.lockedById)
          : existingTaskRun.lockedToVersionId
          ? await getWorkerDeploymentFromWorker(existingTaskRun.lockedToVersionId)
          : await findCurrentWorkerDeployment(existingTaskRun.runtimeEnvironmentId);

        if (!deployment || !deployment.worker) {
          logger.error("No matching deployment found for task run", {
            queueMessage: message.data,
            messageId: message.messageId,
          });

          await this.#markRunAsWaitingForDeploy(existingTaskRun.id);

          await this.#ackAndDoMoreWork(message.messageId);
          return;
        }

        if (!deployment.imageReference) {
          logger.error("Deployment is missing an image reference", {
            queueMessage: message.data,
            messageId: message.messageId,
            deployment: deployment.id,
          });

          await this.#markRunAsWaitingForDeploy(existingTaskRun.id);

          await this.#ackAndDoMoreWork(message.messageId);
          return;
        }

        const backgroundTask = deployment.worker.tasks.find(
          (task) => task.slug === existingTaskRun.taskIdentifier
        );

        if (!backgroundTask) {
          const nonCurrentTask = await prisma.backgroundWorkerTask.findFirst({
            where: {
              slug: existingTaskRun.taskIdentifier,
              projectId: existingTaskRun.projectId,
              runtimeEnvironmentId: existingTaskRun.runtimeEnvironmentId,
            },
            include: {
              worker: {
                include: {
                  deployment: {
                    include: {},
                  },
                },
              },
            },
          });

          if (nonCurrentTask) {
            logger.warn("Task for this run exists but is not part of the current deploy", {
              taskRun: existingTaskRun.id,
              taskIdentifier: existingTaskRun.taskIdentifier,
            });
          } else {
            logger.warn("Task for this run has never been deployed", {
              taskRun: existingTaskRun.id,
              taskIdentifier: existingTaskRun.taskIdentifier,
            });
          }

          await this.#markRunAsWaitingForDeploy(existingTaskRun.id);

          // If this task is ever deployed, a new message will be enqueued after successful indexing
          await this.#ackAndDoMoreWork(message.messageId);
          return;
        }

        const lockedTaskRun = await prisma.taskRun.update({
          where: {
            id: message.messageId,
          },
          data: {
            lockedAt: new Date(),
            lockedById: backgroundTask.id,
            lockedToVersionId: deployment.worker.id,
            taskVersion: deployment.worker.version,
            sdkVersion: deployment.worker.sdkVersion,
            cliVersion: deployment.worker.cliVersion,
            startedAt: existingTaskRun.startedAt ?? new Date(),
            baseCostInCents: env.CENTS_PER_RUN,
            machinePreset:
              existingTaskRun.machinePreset ??
              machinePresetFromConfig(backgroundTask.machineConfig ?? {}).name,
            maxDurationInSeconds: getMaxDuration(
              existingTaskRun.maxDurationInSeconds,
              backgroundTask.maxDurationInSeconds
            ),
          },
          include: {
            runtimeEnvironment: true,
            attempts: {
              take: 1,
              orderBy: { number: "desc" },
            },
            tags: true,
            checkpoints: {
              take: 1,
              orderBy: {
                createdAt: "desc",
              },
            },
            lockedBy: true,
          },
        });

        if (!lockedTaskRun) {
          logger.warn("Failed to lock task run", {
            taskRun: existingTaskRun.id,
            taskIdentifier: existingTaskRun.taskIdentifier,
            deployment: deployment.id,
            backgroundWorker: deployment.worker.id,
            messageId: message.messageId,
          });

          await this.#ackAndDoMoreWork(message.messageId);
          return;
        }

        const queue = await prisma.taskQueue.findUnique({
          where: {
            runtimeEnvironmentId_name: {
              runtimeEnvironmentId: lockedTaskRun.runtimeEnvironmentId,
              name: sanitizeQueueName(lockedTaskRun.queue),
            },
          },
        });

        if (!queue) {
          logger.debug("SharedQueueConsumer queue not found, so nacking message", {
            queueMessage: message,
            taskRunQueue: lockedTaskRun.queue,
            runtimeEnvironmentId: lockedTaskRun.runtimeEnvironmentId,
          });

          await this.#nackAndDoMoreWork(message.messageId, this._options.nextTickInterval);
          return;
        }

        if (!this._enabled) {
          logger.debug("SharedQueueConsumer not enabled, so nacking message", {
            queueMessage: message,
          });

          await marqs?.nackMessage(message.messageId);
          return;
        }

        const nextAttemptNumber = lockedTaskRun.attempts[0]
          ? lockedTaskRun.attempts[0].number + 1
          : 1;

        const isRetry =
          nextAttemptNumber > 1 &&
          (lockedTaskRun.status === "WAITING_TO_RESUME" ||
            lockedTaskRun.status === "RETRYING_AFTER_FAILURE");

        try {
          if (messageBody.data.checkpointEventId) {
            const restoreService = new RestoreCheckpointService();

            const checkpoint = await restoreService.call({
              eventId: messageBody.data.checkpointEventId,
              isRetry,
            });

            if (!checkpoint) {
              logger.error("Failed to restore checkpoint", {
                queueMessage: message.data,
                messageId: message.messageId,
                runStatus: lockedTaskRun.status,
                isRetry,
              });

              await this.#ackAndDoMoreWork(message.messageId);
              return;
            }

            break;
          }

          if (!deployment.worker.supportsLazyAttempts) {
            try {
              const service = new CreateTaskRunAttemptService();
              await service.call({
                runId: lockedTaskRun.id,
                setToExecuting: false,
              });
            } catch (error) {
              logger.error("Failed to create task run attempt for outdate worker", {
                error,
                taskRun: lockedTaskRun.id,
              });

              const service = new CrashTaskRunService();
              await service.call(lockedTaskRun.id, {
                errorCode: TaskRunErrorCodes.OUTDATED_SDK_VERSION,
              });

              await this.#ackAndDoMoreWork(message.messageId);
              return;
            }
          }

          if (isRetry && !messageBody.data.retryCheckpointsDisabled) {
            socketIo.coordinatorNamespace.emit("READY_FOR_RETRY", {
              version: "v1",
              runId: lockedTaskRun.id,
            });

            // Retries for workers with disabled retry checkpoints will be handled just like normal attempts
          } else {
            const machine =
              machinePresetFromRun(lockedTaskRun) ??
              machinePresetFromConfig(lockedTaskRun.lockedBy?.machineConfig ?? {});

            await this._sender.send("BACKGROUND_WORKER_MESSAGE", {
              backgroundWorkerId: deployment.worker.friendlyId,
              data: {
                type: "SCHEDULE_ATTEMPT",
                image: deployment.imageReference,
                version: deployment.version,
                machine,
                nextAttemptNumber,
                // identifiers
                id: "placeholder", // TODO: Remove this completely in a future release
                envId: lockedTaskRun.runtimeEnvironment.id,
                envType: lockedTaskRun.runtimeEnvironment.type,
                orgId: lockedTaskRun.runtimeEnvironment.organizationId,
                projectId: lockedTaskRun.runtimeEnvironment.projectId,
                runId: lockedTaskRun.id,
              },
            });
          }
        } catch (e) {
          if (e instanceof Error) {
            this._currentSpan?.recordException(e);
          } else {
            this._currentSpan?.recordException(new Error(String(e)));
          }

          this._endSpanInNextIteration = true;

          // We now need to unlock the task run and delete the task run attempt
          await prisma.$transaction([
            prisma.taskRun.update({
              where: {
                id: lockedTaskRun.id,
              },
              data: {
                lockedAt: null,
                lockedById: null,
                status: lockedTaskRun.status,
                startedAt: existingTaskRun.startedAt,
              },
            }),
          ]);

          logger.error("SharedQueueConsumer errored, so nacking message", {
            queueMessage: message,
            error: e instanceof Error ? { name: e.name, message: e.message, stack: e.stack } : e,
          });

          await this.#nackAndDoMoreWork(message.messageId);
          return;
        }

        break;
      }
      // MARK: DEP RESUME
      // Resume after dependency completed with no remaining retries
      case "RESUME": {
        if (messageBody.data.checkpointEventId) {
          try {
            const restoreService = new RestoreCheckpointService();

            const checkpoint = await restoreService.call({
              eventId: messageBody.data.checkpointEventId,
            });

            if (!checkpoint) {
              logger.error("Failed to restore checkpoint", {
                queueMessage: message.data,
                messageId: message.messageId,
              });

              await this.#ackAndDoMoreWork(message.messageId);
              return;
            }
          } catch (e) {
            if (e instanceof Error) {
              this._currentSpan?.recordException(e);
            } else {
              this._currentSpan?.recordException(new Error(String(e)));
            }

            this._endSpanInNextIteration = true;

            await this.#nackAndDoMoreWork(message.messageId);
            return;
          }

          this.#doMoreWork();
          return;
        }

        const resumableRun = await prisma.taskRun.findUnique({
          where: {
            id: message.messageId,
            status: {
              notIn: FINAL_RUN_STATUSES,
            },
          },
        });

        if (!resumableRun) {
          logger.error("Resumable run not found", {
            queueMessage: message.data,
            messageId: message.messageId,
          });

          await this.#ackAndDoMoreWork(message.messageId);
          return;
        }

        if (resumableRun.status !== "EXECUTING") {
          logger.warn("Run is not executing, will try to resume anyway", {
            queueMessage: message.data,
            messageId: message.messageId,
            runStatus: resumableRun.status,
          });
        }

        const resumableAttempt = await prisma.taskRunAttempt.findUnique({
          where: {
            id: messageBody.data.resumableAttemptId,
          },
          include: {
            checkpoints: {
              take: 1,
              orderBy: {
                createdAt: "desc",
              },
            },
          },
        });

        if (!resumableAttempt) {
          logger.error("Resumable attempt not found", {
            queueMessage: message.data,
            messageId: message.messageId,
          });

          await this.#ackAndDoMoreWork(message.messageId);
          return;
        }

        const queue = await prisma.taskQueue.findUnique({
          where: {
            runtimeEnvironmentId_name: {
              runtimeEnvironmentId: resumableAttempt.runtimeEnvironmentId,
              name: sanitizeQueueName(resumableRun.queue),
            },
          },
        });

        if (!queue) {
          logger.debug("SharedQueueConsumer queue not found, so nacking message", {
            queueName: sanitizeQueueName(resumableRun.queue),
            attempt: resumableAttempt,
          });

          await this.#nackAndDoMoreWork(message.messageId, this._options.nextTickInterval);
          return;
        }

        if (!this._enabled) {
          await marqs?.nackMessage(message.messageId);
          return;
        }

        const completions: TaskRunExecutionResult[] = [];
        const executions: TaskRunExecution[] = [];

        for (const completedAttemptId of messageBody.data.completedAttemptIds) {
          const completedAttempt = await prisma.taskRunAttempt.findUnique({
            where: {
              id: completedAttemptId,
              taskRun: {
                lockedAt: {
                  not: null,
                },
                lockedById: {
                  not: null,
                },
              },
            },
          });

          if (!completedAttempt) {
            logger.error("Completed attempt not found", {
              queueMessage: message.data,
              messageId: message.messageId,
            });

            await this.#ackAndDoMoreWork(message.messageId);
            return;
          }

          const completion = await this._tasks.getCompletionPayloadFromAttempt(completedAttempt.id);

          if (!completion) {
            await this.#ackAndDoMoreWork(message.messageId);
            return;
          }

          completions.push(completion);

          const executionPayload = await this._tasks.getExecutionPayloadFromAttempt({
            id: completedAttempt.id,
          });

          if (!executionPayload) {
            await this.#ackAndDoMoreWork(message.messageId);
            return;
          }

          executions.push(executionPayload.execution);
        }

        try {
          const resumeMessage = {
            version: "v1" as const,
            runId: resumableAttempt.taskRunId,
            attemptId: resumableAttempt.id,
            attemptFriendlyId: resumableAttempt.friendlyId,
            completions,
            executions,
          };

          logger.debug("Broadcasting RESUME_AFTER_DEPENDENCY_WITH_ACK", {
            resumeMessage,
            message,
            resumableRun,
          });

          // The attempt should still be running so we can broadcast to all coordinators to resume immediately
          const responses = await socketIo.coordinatorNamespace
            .timeout(10_000)
            .emitWithAck("RESUME_AFTER_DEPENDENCY_WITH_ACK", resumeMessage);

          logger.debug("RESUME_AFTER_DEPENDENCY_WITH_ACK received", {
            resumeMessage,
            responses,
            message,
          });

          if (responses.length === 0) {
            logger.error("RESUME_AFTER_DEPENDENCY_WITH_ACK no response", {
              resumeMessage,
              message,
            });
            await this.#nackAndDoMoreWork(message.messageId, this._options.nextTickInterval, 5_000);
            return;
          }

          const hasSuccess = responses.some((response) => response.success);

          if (hasSuccess) {
            this.#doMoreWork();
            return;
          }

          // No coordinator was able to resume the run
          logger.warn("RESUME_AFTER_DEPENDENCY_WITH_ACK failed", {
            resumeMessage,
            responses,
            message,
          });

          // Let's check if the run is frozen
          if (resumableRun.status === "WAITING_TO_RESUME") {
            logger.debug("RESUME_AFTER_DEPENDENCY_WITH_ACK run is waiting to be restored", {
              queueMessage: message.data,
              messageId: message.messageId,
            });

            try {
              const restoreService = new RestoreCheckpointService();

              const checkpointEvent = await restoreService.getLastCheckpointEventIfUnrestored(
                resumableRun.id
              );

              if (checkpointEvent) {
                // The last checkpoint hasn't been restored yet, so restore it
                const checkpoint = await restoreService.call({
                  eventId: checkpointEvent.id,
                });

                if (!checkpoint) {
                  logger.debug("RESUME_AFTER_DEPENDENCY_WITH_ACK failed to restore checkpoint", {
                    queueMessage: message.data,
                    messageId: message.messageId,
                  });

                  await this.#ackAndDoMoreWork(message.messageId);
                  return;
                }

                logger.debug("RESUME_AFTER_DEPENDENCY_WITH_ACK restored checkpoint", {
                  queueMessage: message.data,
                  messageId: message.messageId,
                  checkpoint,
                });

                this.#doMoreWork();
                return;
              } else {
                logger.debug(
                  "RESUME_AFTER_DEPENDENCY_WITH_ACK run is frozen without last checkpoint event",
                  {
                    queueMessage: message.data,
                    messageId: message.messageId,
                  }
                );
              }
            } catch (e) {
              if (e instanceof Error) {
                this._currentSpan?.recordException(e);
              } else {
                this._currentSpan?.recordException(new Error(String(e)));
              }

              this._endSpanInNextIteration = true;

              await this.#nackAndDoMoreWork(
                message.messageId,
                this._options.nextTickInterval,
                5_000
              );
              return;
            }
          }

          logger.debug("RESUME_AFTER_DEPENDENCY_WITH_ACK retrying", {
            queueMessage: message.data,
            messageId: message.messageId,
          });

          await this.#nackAndDoMoreWork(message.messageId, this._options.nextTickInterval, 5_000);
          return;
        } catch (e) {
          if (e instanceof Error) {
            this._currentSpan?.recordException(e);
          } else {
            this._currentSpan?.recordException(new Error(String(e)));
          }

          this._endSpanInNextIteration = true;

          logger.error("RESUME_AFTER_DEPENDENCY_WITH_ACK threw, nacking with delay", {
            message,
            error: e,
          });

          await this.#nackAndDoMoreWork(message.messageId, this._options.nextTickInterval, 5_000);
          return;
        }

        break;
      }
      // MARK: DURATION RESUME
      // Resume after duration-based wait
      case "RESUME_AFTER_DURATION": {
        try {
          const restoreService = new RestoreCheckpointService();

          const checkpoint = await restoreService.call({
            eventId: messageBody.data.checkpointEventId,
          });

          if (!checkpoint) {
            logger.error("Failed to restore checkpoint", {
              queueMessage: message.data,
              messageId: message.messageId,
            });

            await this.#ackAndDoMoreWork(message.messageId);
            return;
          }
        } catch (e) {
          if (e instanceof Error) {
            this._currentSpan?.recordException(e);
          } else {
            this._currentSpan?.recordException(new Error(String(e)));
          }

          this._endSpanInNextIteration = true;

          await this.#nackAndDoMoreWork(message.messageId);
          return;
        }

        break;
      }
      // MARK: FAIL
      // Fail for whatever reason, usually runs that have been resumed but stopped heartbeating
      case "FAIL": {
        const existingTaskRun = await prisma.taskRun.findUnique({
          where: {
            id: message.messageId,
          },
        });

        if (!existingTaskRun) {
          logger.error("No existing task run to fail", {
            queueMessage: messageBody,
            messageId: message.messageId,
          });

          await this.#ackAndDoMoreWork(message.messageId);
          return;
        }

        // TODO: Consider failing the attempt and retrying instead. This may not be a good idea, as dequeued FAIL messages tend to point towards critical, persistent errors.
        const service = new CrashTaskRunService();
        await service.call(existingTaskRun.id, {
          crashAttempts: true,
          reason: messageBody.data.reason,
        });

        await this.#ackAndDoMoreWork(message.messageId);
        return;
      }
    }

    this.#doMoreWork();
    return;
  }

  #doMoreWork(intervalInMs = this._options.interval) {
    setTimeout(() => this.#doWork(), intervalInMs);
  }

  async #ackAndDoMoreWork(messageId: string, intervalInMs?: number) {
    await marqs?.acknowledgeMessage(messageId, "Acking and doing more work in SharedQueueConsumer");
    this.#doMoreWork(intervalInMs);
  }

  async #nackAndDoMoreWork(messageId: string, queueIntervalInMs?: number, nackRetryInMs?: number) {
    const retryAt = nackRetryInMs ? Date.now() + nackRetryInMs : undefined;
    await marqs?.nackMessage(messageId, retryAt);
    this.#doMoreWork(queueIntervalInMs);
  }

  async #markRunAsWaitingForDeploy(runId: string) {
    logger.debug("Marking run as waiting for deploy", { runId });

    return await prisma.taskRun.update({
      where: {
        id: runId,
      },
      data: {
        status: "WAITING_FOR_DEPLOY",
      },
    });
  }
}

type AttemptForCompletion = Prisma.TaskRunAttemptGetPayload<{
  include: {
    backgroundWorker: true;
    backgroundWorkerTask: true;
    taskRun: {
      include: {
        runtimeEnvironment: {
          include: {
            organization: true;
            project: true;
          };
        };
        tags: true;
      };
    };
    queue: true;
  };
}>;

type AttemptForExecution = Prisma.TaskRunAttemptGetPayload<{
  include: {
    backgroundWorker: true;
    backgroundWorkerTask: true;
    runtimeEnvironment: {
      include: {
        organization: true;
        project: true;
      };
    };
    taskRun: {
      include: {
        tags: true;
        batchItems: {
          include: {
            batchTaskRun: {
              select: {
                friendlyId: true;
              };
            };
          };
        };
      };
    };
    queue: true;
  };
}>;

class SharedQueueTasks {
  private _completionPayloadFromAttempt(attempt: AttemptForCompletion): TaskRunExecutionResult {
    const ok = attempt.status === "COMPLETED";

    if (ok) {
      const success: TaskRunSuccessfulExecutionResult = {
        ok,
        id: attempt.taskRun.friendlyId,
        output: attempt.output ?? undefined,
        outputType: attempt.outputType,
        taskIdentifier: attempt.taskRun.taskIdentifier,
      };
      return success;
    } else {
      const failure: TaskRunFailedExecutionResult = {
        ok,
        id: attempt.taskRun.friendlyId,
        error: attempt.error as TaskRunError,
        taskIdentifier: attempt.taskRun.taskIdentifier,
      };
      return failure;
    }
  }

  private async _executionFromAttempt(
    attempt: AttemptForExecution,
    machinePreset?: MachinePreset
  ): Promise<ProdTaskRunExecution> {
    const { backgroundWorkerTask, taskRun, queue } = attempt;

    if (!machinePreset) {
      machinePreset =
        machinePresetFromRun(attempt.taskRun) ??
        machinePresetFromConfig(backgroundWorkerTask.machineConfig ?? {});
    }

    const metadata = await parsePacket({
      data: taskRun.metadata ?? undefined,
      dataType: taskRun.metadataType,
    });

    const execution: ProdTaskRunExecution = {
      task: {
        id: backgroundWorkerTask.slug,
        filePath: backgroundWorkerTask.filePath,
        exportName: backgroundWorkerTask.exportName,
      },
      attempt: {
        id: attempt.friendlyId,
        number: attempt.number,
        startedAt: attempt.startedAt ?? attempt.createdAt,
        backgroundWorkerId: attempt.backgroundWorkerId,
        backgroundWorkerTaskId: attempt.backgroundWorkerTaskId,
        status: "EXECUTING" as const,
      },
      run: {
        id: taskRun.friendlyId,
        payload: taskRun.payload,
        payloadType: taskRun.payloadType,
        context: taskRun.context,
        createdAt: taskRun.createdAt,
        startedAt: taskRun.startedAt ?? taskRun.createdAt,
        tags: taskRun.tags.map((tag) => tag.name),
        isTest: taskRun.isTest,
        idempotencyKey: taskRun.idempotencyKey ?? undefined,
        durationMs: taskRun.usageDurationMs,
        costInCents: taskRun.costInCents,
        baseCostInCents: taskRun.baseCostInCents,
        metadata,
        maxDuration: taskRun.maxDurationInSeconds ?? undefined,
      },
      queue: {
        id: queue.friendlyId,
        name: queue.name,
      },
      environment: {
        id: attempt.runtimeEnvironment.id,
        slug: attempt.runtimeEnvironment.slug,
        type: attempt.runtimeEnvironment.type,
      },
      organization: {
        id: attempt.runtimeEnvironment.organization.id,
        slug: attempt.runtimeEnvironment.organization.slug,
        name: attempt.runtimeEnvironment.organization.title,
      },
      project: {
        id: attempt.runtimeEnvironment.project.id,
        ref: attempt.runtimeEnvironment.project.externalRef,
        slug: attempt.runtimeEnvironment.project.slug,
        name: attempt.runtimeEnvironment.project.name,
      },
      batch:
        taskRun.batchItems[0] && taskRun.batchItems[0].batchTaskRun
          ? { id: taskRun.batchItems[0].batchTaskRun.friendlyId }
          : undefined,
      worker: {
        id: attempt.backgroundWorkerId,
        contentHash: attempt.backgroundWorker.contentHash,
        version: attempt.backgroundWorker.version,
      },
      machine: machinePreset,
    };

    return execution;
  }

  async getCompletionPayloadFromAttempt(id: string): Promise<TaskRunExecutionResult | undefined> {
    const attempt = await prisma.taskRunAttempt.findFirst({
      where: {
        id,
        status: {
          in: FINAL_ATTEMPT_STATUSES,
        },
      },
      include: {
        backgroundWorker: true,
        backgroundWorkerTask: true,
        taskRun: {
          include: {
            runtimeEnvironment: {
              include: {
                organization: true,
                project: true,
              },
            },
            tags: true,
          },
        },
        queue: true,
      },
    });

    if (!attempt) {
      logger.error("No completed attempt found", { id });
      return;
    }

    return this._completionPayloadFromAttempt(attempt);
  }

  async getExecutionPayloadFromAttempt({
    id,
    setToExecuting,
    isRetrying,
    skipStatusChecks,
  }: {
    id: string;
    setToExecuting?: boolean;
    isRetrying?: boolean;
    skipStatusChecks?: boolean;
  }): Promise<ProdTaskRunExecutionPayload | undefined> {
    const attempt = await prisma.taskRunAttempt.findFirst({
      where: {
        id,
      },
      include: {
        backgroundWorker: true,
        backgroundWorkerTask: true,
        runtimeEnvironment: {
          include: {
            organization: true,
            project: true,
          },
        },
        taskRun: {
          include: {
            tags: true,
            batchItems: {
              include: {
                batchTaskRun: {
                  select: {
                    friendlyId: true,
                  },
                },
              },
            },
          },
        },
        queue: true,
      },
    });

    if (!attempt) {
      logger.error("getExecutionPayloadFromAttempt: No attempt found", { id });
      return;
    }

    if (!skipStatusChecks) {
      switch (attempt.status) {
        case "CANCELED":
        case "EXECUTING": {
          logger.error(
            "getExecutionPayloadFromAttempt: Invalid attempt status for execution payload retrieval",
            {
              attemptId: id,
              status: attempt.status,
            }
          );
          return;
        }
      }

      switch (attempt.taskRun.status) {
        case "CANCELED":
        case "EXECUTING":
        case "INTERRUPTED": {
          logger.error(
            "getExecutionPayloadFromAttempt: Invalid run status for execution payload retrieval",
            {
              attemptId: id,
              runId: attempt.taskRunId,
              status: attempt.taskRun.status,
            }
          );
          return;
        }
      }
    }

    if (setToExecuting) {
      if (isFinalAttemptStatus(attempt.status) || isFinalRunStatus(attempt.taskRun.status)) {
        logger.error("getExecutionPayloadFromAttempt: Status already in final state", {
          attempt: {
            id: attempt.id,
            status: attempt.status,
          },
          run: {
            id: attempt.taskRunId,
            status: attempt.taskRun.status,
          },
        });
        return;
      }

      await prisma.taskRunAttempt.update({
        where: {
          id,
        },
        data: {
          status: "EXECUTING",
          taskRun: {
            update: {
              data: {
                status: isRetrying ? "RETRYING_AFTER_FAILURE" : "EXECUTING",
              },
            },
          },
        },
      });
    }

    const { backgroundWorkerTask, taskRun } = attempt;

    const machinePreset =
      machinePresetFromRun(attempt.taskRun) ??
      machinePresetFromConfig(backgroundWorkerTask.machineConfig ?? {});

    const execution = await this._executionFromAttempt(attempt, machinePreset);
    const variables = await this.#buildEnvironmentVariables(
      attempt.runtimeEnvironment,
      taskRun.id,
      machinePreset
    );

    const payload: ProdTaskRunExecutionPayload = {
      execution,
      traceContext: taskRun.traceContext as Record<string, unknown>,
      environment: variables.reduce((acc: Record<string, string>, curr) => {
        acc[curr.key] = curr.value;
        return acc;
      }, {}),
    };

    return payload;
  }

  async getResumePayload(attemptId: string): Promise<
    | {
        execution: ProdTaskRunExecution;
        completion: TaskRunExecutionResult;
      }
    | undefined
  > {
    const attempt = await prisma.taskRunAttempt.findFirst({
      where: {
        id: attemptId,
      },
      include: {
        backgroundWorker: true,
        backgroundWorkerTask: true,
        runtimeEnvironment: {
          include: {
            organization: true,
            project: true,
          },
        },
        taskRun: {
          include: {
            runtimeEnvironment: {
              include: {
                organization: true,
                project: true,
              },
            },
            tags: true,
            batchItems: {
              include: {
                batchTaskRun: {
                  select: {
                    friendlyId: true,
                  },
                },
              },
            },
          },
        },
        queue: true,
      },
    });

    if (!attempt) {
      logger.error("getResumePayload: No attempt found", { id: attemptId });
      return;
    }

    const execution = await this._executionFromAttempt(attempt);
    const completion = this._completionPayloadFromAttempt(attempt);

    return {
      execution,
      completion,
    };
  }

  async getLatestExecutionPayloadFromRun(
    id: string,
    setToExecuting?: boolean,
    isRetrying?: boolean
  ): Promise<ProdTaskRunExecutionPayload | undefined> {
    const run = await prisma.taskRun.findUnique({
      where: {
        id,
      },
      include: {
        attempts: {
          take: 1,
          orderBy: {
            createdAt: "desc",
          },
        },
      },
    });

    const latestAttempt = run?.attempts[0];

    if (!latestAttempt) {
      logger.error("No attempts for run", { id });
      return;
    }

    return this.getExecutionPayloadFromAttempt({
      id: latestAttempt.id,
      setToExecuting,
      isRetrying,
    });
  }

  async getLazyAttemptPayload(
    envId: string,
    runId: string
  ): Promise<TaskRunExecutionLazyAttemptPayload | undefined> {
    const environment = await findEnvironmentById(envId);

    if (!environment) {
      logger.error("getLazyAttemptPayload: Environment not found", { runId, envId });
      return;
    }

    const run = await prisma.taskRun.findFirst({
      where: {
        id: runId,
      },
      select: {
        id: true,
        traceContext: true,
        friendlyId: true,
        isTest: true,
        lockedBy: {
          select: {
            machineConfig: true,
          },
        },
        machinePreset: true,
      },
    });

    if (!run) {
      logger.error("getLazyAttemptPayload: Run not found", { runId, envId });
      return;
    }

    const attemptCount = await prisma.taskRunAttempt.count({
      where: {
        taskRunId: run.id,
      },
    });

    logger.debug("getLazyAttemptPayload: Getting lazy attempt payload for run", {
      run,
      attemptCount,
    });

    const machinePreset =
      machinePresetFromRun(run) ?? machinePresetFromConfig(run.lockedBy?.machineConfig ?? {});

    const variables = await this.#buildEnvironmentVariables(environment, run.id, machinePreset);

    return {
      traceContext: run.traceContext as Record<string, unknown>,
      environment: variables.reduce((acc: Record<string, string>, curr) => {
        acc[curr.key] = curr.value;
        return acc;
      }, {}),
      runId: run.friendlyId,
      messageId: run.id,
      isTest: run.isTest,
      attemptCount,
    } satisfies TaskRunExecutionLazyAttemptPayload;
  }

  async taskHeartbeat(attemptFriendlyId: string) {
    logger.debug("[SharedQueueConsumer] taskHeartbeat()", { id: attemptFriendlyId });

    const taskRunAttempt = await prisma.taskRunAttempt.findUnique({
      where: { friendlyId: attemptFriendlyId },
    });

    if (!taskRunAttempt) {
      return;
    }

    await this.#heartbeat(taskRunAttempt.taskRunId);
  }

  async taskRunHeartbeat(runId: string) {
    logger.debug("[SharedQueueConsumer] taskRunHeartbeat()", { runId });

    await this.#heartbeat(runId);
  }

  public async taskRunFailed(completion: TaskRunFailedExecutionResult) {
    logger.debug("[SharedQueueConsumer] taskRunFailed()", { completion });

    const service = new FailedTaskRunService();

    await service.call(completion.id, completion);
  }

  async #heartbeat(runId: string) {
    await marqs?.heartbeatMessage(runId);

    try {
      // There can be a lot of calls per minute and the data doesn't have to be accurate, so use the read replica
      const taskRun = await $replica.taskRun.findFirst({
        where: {
          id: runId,
        },
        select: {
          id: true,
          status: true,
          runtimeEnvironment: {
            select: {
              type: true,
            },
          },
          lockedToVersion: {
            select: {
              supportsLazyAttempts: true,
            },
          },
        },
      });

      if (!taskRun) {
        logger.error("SharedQueueTasks.#heartbeat: Task run not found", {
          runId,
        });

        return;
      }

      if (taskRun.runtimeEnvironment.type === "DEVELOPMENT") {
        return;
      }

      if (isFinalRunStatus(taskRun.status)) {
        logger.debug("SharedQueueTasks.#heartbeat: Task run is in final status", {
          runId,
          status: taskRun.status,
        });

        // Signal to exit any leftover containers
        socketIo.coordinatorNamespace.emit("REQUEST_RUN_CANCELLATION", {
          version: "v1",
          runId: taskRun.id,
          // Give the run a few seconds to exit to complete any flushing etc
          delayInMs: taskRun.lockedToVersion?.supportsLazyAttempts ? 5_000 : undefined,
        });
        return;
      }
    } catch (error) {
      logger.error("SharedQueueTasks.#heartbeat: Error signaling run cancellation", {
        runId,
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  async #buildEnvironmentVariables(
    environment: RuntimeEnvironment,
    runId: string,
    machinePreset: MachinePreset
  ): Promise<Array<EnvironmentVariable>> {
    const variables = await resolveVariablesForEnvironment(environment);

    const jwt = await generateJWTTokenForEnvironment(environment, {
      run_id: runId,
      machine_preset: machinePreset.name,
    });

    return [
      ...variables,
      ...[
        { key: "TRIGGER_JWT", value: jwt },
        { key: "TRIGGER_RUN_ID", value: runId },
        {
          key: "TRIGGER_MACHINE_PRESET",
          value: machinePreset.name,
        },
      ],
    ];
  }
}

export const sharedQueueTasks = singleton("sharedQueueTasks", () => new SharedQueueTasks());
