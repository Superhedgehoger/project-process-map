import { CindyOrchestrator } from "./cindy/orchestrator.ts";
import { reconcileCurrentState } from "./cindy/reconcile.ts";

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "status";
  const repoDir = process.cwd();
  const orchestrator = new CindyOrchestrator({ repoDir });

  switch (command) {
    case "status": {
      const status = await orchestrator.getStatus();
      const reconcile = await reconcileCurrentState({ repoDir });
      console.log(
        JSON.stringify(
          {
            git: {
              branch: status.branch,
              headCommit: status.headCommit,
              isClean: status.isClean,
              dirtyFiles: status.dirtyFiles,
              treeDigest: status.treeDigest,
            },
            reconcile: {
              currentTaskId: reconcile.currentTaskId,
              taskAlreadyClosed: reconcile.taskAlreadyClosed,
              resolvedStatus: reconcile.resolvedStatus,
              stopReason: reconcile.stopReason,
              stopExplanation: reconcile.stopExplanation,
            },
          },
          null,
          2
        )
      );
      break;
    }

    case "reconcile": {
      const result = await reconcileCurrentState({ repoDir });
      console.log(JSON.stringify(result, null, 2));
      if (!result.reconciled || result.stopReason) {
        process.exitCode = 1;
      }
      break;
    }

    case "init": {
      const taskIndex = args.indexOf("--task");
      const taskId = taskIndex !== -1 ? args[taskIndex + 1] : undefined;

      // current.json is a hint, never authority to select an initialization task.
      if (!taskId || taskId.startsWith("--")) {
        console.error(JSON.stringify({
          error: "CURRENT_TASK_UNRESOLVED",
          message: "cindy:init requires an explicit --task <taskId>; .agent/current.json cannot authorize initialization",
        }, null, 2));
        process.exitCode = 1;
        return;
      }

      const runId = `run-${taskId.toLowerCase()}-${Date.now()}`;
      const run = await orchestrator.initRun({
        runId,
        taskId,
      });

      console.log(JSON.stringify(run, null, 2));
      break;
    }

    default:
      console.error(`Unknown Cindy command: ${command}. Allowed: status, reconcile, init`);
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error("Cindy CLI failure:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
