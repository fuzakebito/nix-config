import { describe, expect, test } from "bun:test";
import { completeTask, createPlan, getNextTask, getProgress, getReadyWave, parsePlanReviewOutput, renderPlanMarkdown, reviewPlan } from "./core.ts";

function planInput() {
  return {
    title: "Add plan execution",
    goal: "Execute reviewed plans durably",
    analysis: "The repository already has Pi and subagent extensions.",
    constraints: ["Keep workflow state outside model context"],
    tasks: [
      {
        title: "Implement state",
        details: "Add the native state machine.",
        references: ["home/pi/default.nix"],
        acceptance: ["State survives restart"],
        verification: ["bun test"],
        wave: 1,
        ownedPaths: ["home/pi/files/plan-execute"],
      },
      {
        title: "Wire extension",
        details: "Load it through Home Manager.",
        acceptance: ["Pi loads the command"],
        verification: ["nix flake check"],
        dependsOn: ["1"],
        wave: 2,
        ownedPaths: ["home/pi/default.nix"],
      },
    ],
  };
}

describe("plan state", () => {
  test("adds the mandatory verification wave and renders only top-level progress", () => {
    const plan = createPlan(planInput());
    expect(plan.tasks.map((task) => task.id)).toEqual(["1", "2", "F1", "F2", "F3", "F4"]);
    expect(plan.tasks.map((task) => task.wave)).toEqual([1, 2, 3, 3, 3, 3]);
    expect(getProgress(plan)).toEqual({ completed: 0, total: 6, remaining: 6 });
    expect(renderPlanMarkdown(plan)).toContain("## Final Verification Wave\n- [ ] F1. Plan compliance audit");
    expect(plan.revision).toBe(1);
    expect(plan.reviewToken).toBeTruthy();
  });

  test("issues a fresh review identity and parses structured reviewer output", () => {
    const first = createPlan(planInput());
    const second = createPlan(planInput(), first);
    expect(second.revision).toBe(2);
    expect(second.reviewToken).not.toBe(first.reviewToken);
    expect(parsePlanReviewOutput(JSON.stringify({
      planPath: `.pi/work/plans/${second.slug}.md`,
      reviewToken: second.reviewToken,
      verdict: "rejected",
      findings: ["Fix the dependency"],
    })).verdict).toBe("rejected");
    expect(() => parsePlanReviewOutput("VERDICT: APPROVED")).toThrow("JSON object");
  });

  test("requires approval and forward-only task completion", () => {
    let plan = reviewPlan(createPlan(planInput()), "approved", []);
    expect(plan.review.verdict).toBe("approved");
    expect(getNextTask(plan)?.id).toBe("1");
    expect(() =>
      completeTask(plan, {
        taskId: "2",
        summary: "wired",
        commands: ["nix flake check"],
        artifact: ".pi/work/evidence/task-2.txt",
        adversarialChecks: ["resume"],
        cleanup: ["none required"],
        timestamp: new Date().toISOString(),
      }),
    ).toThrow("blocked");

    plan = completeTask(plan, {
      taskId: "1",
      summary: "state added",
      commands: ["bun test"],
      artifact: ".pi/work/evidence/task-1.txt",
      adversarialChecks: ["resume"],
      cleanup: ["none required"],
      timestamp: new Date().toISOString(),
    });
    expect(getNextTask(plan)?.id).toBe("2");
  });

  test("returns dependency-safe parallel waves and rejects overlapping ownership", () => {
    const input = planInput();
    input.tasks[1].dependsOn = [];
    input.tasks[1].wave = 1;
    const plan = createPlan(input);
    expect(getReadyWave(plan).map((task) => task.id)).toEqual(["1", "2"]);

    input.tasks[1].ownedPaths = ["home/pi/files"];
    expect(() => createPlan(input)).toThrow("overlapping owned paths");
  });

  test("refuses completion without concrete evidence", () => {
    const plan = reviewPlan(createPlan(planInput()), "approved", []);
    expect(() =>
      completeTask(plan, {
        taskId: "1",
        summary: "claimed done",
        commands: ["bun test"],
        adversarialChecks: ["resume"],
        cleanup: ["none required"],
        timestamp: new Date().toISOString(),
      }),
    ).toThrow("artifact");
  });
});
