import { atom, read, update } from "claude-code";
import type { EngineInterface, Register } from "claude-code";

import type { Question, Quiz } from "../types";

const PANE = "learning-mode";
const TOOL = "mcp__learning-mode__quiz";
const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
// Files Claude may touch per task before a quiz is required.
const FREE_FILES = 1;

const enabled = atom({ plugin: "learning-mode", key: "enabled" } as const, false);
const quiz = atom({ plugin: "learning-mode", key: "quiz" } as const, null);
const cleared = atom({ plugin: "learning-mode", key: "cleared" } as const, false);
const touched = atom({ plugin: "learning-mode", key: "touched" } as const, []);

const INSTRUCTIONS = `# Learning mode is ON

The user has enabled learning mode: they want to understand what you build, not just receive it.

Before any bigger implementation step (creating a new module/file, changing more than one file, introducing a new dependency, data model, API or architectural pattern, or any multi-step plan), you MUST:
1. Call the \`${TOOL}\` tool with 3-5 understanding questions about that plan.
2. End your turn immediately after the tool returns. Do not edit files until the user has passed. You will receive a message saying the user passed; then continue.

Good questions test real understanding and are answerable in a few words: "What is the purpose of module X?", "Why does X call Y instead of Z?", "What happens to the data between A and B?", "What would break if we removed C?", "Which component is responsible for D?". Avoid trivia (exact names, line numbers, syntax) and yes/no questions.

Small, local edits (a typo, a one-line fix, a single small change in one file) do not need a quiz. File edits are blocked by the harness while a quiz is pending, or once you touch more than ${FREE_FILES} file(s) for a task without a passed quiz.`;

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "learning-mode",
      description: "Quiz me on what Claude is about to build before it implements it",
      argumentHint: "[on|off|status|skip|show]",
    });
    await $.tool.register({
      name: "quiz",
      description:
        "Learning mode: show the user high-level understanding questions about the implementation you are about to do, in a side panel. " +
        "The user must answer all correctly before you may implement. After calling this, end your turn and wait.",
      isDeferred: false,
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short name of what is about to be built" },
          questions: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 6,
            description: "3-5 conceptual questions about purposes of modules, data flow, design decisions",
          },
        },
        required: ["title", "questions"],
      },
    });

    const stored = await $.store.get("enabled");
    await update($, enabled, () => stored === true);
    if ((await read($, quiz))?.status === "pending") void openPane($, false);

    return next(e);
  });

  on("command.run", { command: "learning-mode" }, async ($, e) => {
    const arg = e.args.trim().toLowerCase();
    const isOn = await read($, enabled);
    const current = await read($, quiz);

    if (arg === "status") {
      const pending = current?.status === "pending" ? " A quiz is waiting for your answers." : "";
      return { text: `Learning mode is ${isOn ? "on" : "off"}.${pending}` };
    }
    if (arg === "show") {
      if (current === null) return { text: "No quiz yet." };
      await openPane($, true);
      return { text: "Quiz panel opened." };
    }
    if (arg === "skip") {
      if (current?.status !== "pending") return { text: "There is no pending quiz to skip." };
      await finish($, current, "skipped");
      return { text: "Quiz skipped. Claude will continue." };
    }

    const turnOn = arg === "on" ? true : arg === "off" ? false : arg === "" ? !isOn : undefined;
    if (turnOn === undefined) {
      return { text: "Usage: /learning-mode [on|off|status|skip|show]" };
    }
    await update($, enabled, () => turnOn);
    await $.store.set("enabled", turnOn);
    if (!turnOn) {
      await update($, quiz, (q) => (q?.status === "pending" ? { ...q, status: "skipped" as const } : q));
      await $.ui.close({ id: PANE });
    }
    $.ui.status(turnOn ? "learning mode" : undefined);
    if (turnOn) await openPane($, false);

    return {
      text: turnOn ? "Learning mode on. Before bigger implementation steps, Claude will quiz you in a side panel." : "Learning mode off.",
    };
  });

  on("prompt.compose", async ($, e, next) => {
    const result = await next(e);
    if (!(await read($, enabled))) return result;

    return {
      sections: [...result.sections, { id: "learning-mode:rules", text: INSTRUCTIONS, scope: "session" as const }],
    };
  });

  // A new task from the person needs a new understanding check.
  on("prompt.submit", async ($, e, next) => {
    if (e.origin.kind === "composer" || e.origin.kind === "bridge") {
      await update($, cleared, () => false);
      await update($, touched, () => []);
      // Opened while answering the person's prompt, the pane is placed at any width;
      // an open from the quiz tool alone waits for a 144-column terminal.
      if (await read($, enabled)) void openPane($, false);
    }
    if (await read($, enabled)) $.ui.status("learning mode");

    return next(e);
  }).catch(($, e, next) => next(e));

  on("tool.call", { tool: TOOL }, async ($, e) => {
    const input = e as unknown as { title?: unknown; questions?: unknown };
    if (!(await read($, enabled))) {
      return { result: "Learning mode is off; no quiz needed. Continue." };
    }
    const texts = Array.isArray(input.questions) ? input.questions.filter((q): q is string => typeof q === "string" && q.trim() !== "") : [];
    if (texts.length === 0) return { deny: "Provide at least one question." };

    const next: Quiz = {
      id: e.tool_use_id,
      title: typeof input.title === "string" ? input.title : "Upcoming implementation",
      status: "pending",
      questions: texts.slice(0, 6).map((text) => ({
        text,
        answer: "",
        verdict: "unanswered",
        feedback: "",
        attempts: 0,
      })),
    };
    await update($, quiz, () => next);
    await openPane($, true);

    return {
      result:
        "The questions are shown to the user in the learning-mode panel. End your turn now and make no changes. " +
        "You will receive a message once the user has answered all of them correctly; then continue with the implementation.",
    };
  }).catch(() => ({ deny: "learning-mode: could not show the quiz; continue without it." }));

  on("tool.call", async ($, e, next) => {
    if (!EDIT_TOOLS.has(String(e.tool)) || !(await read($, enabled))) return next(e);

    const current = await read($, quiz);
    if (current?.status === "pending") {
      return {
        deny:
          "learning-mode: the user has not yet passed the understanding check shown in the side panel. " +
          "End your turn and wait for the message that they passed.",
      };
    }
    if (await read($, cleared)) return next(e);

    const input = e as unknown as { file_path?: unknown; notebook_path?: unknown };
    const path = String(input.file_path ?? input.notebook_path ?? "");
    const files = await update($, touched, (list) => (list.includes(path) ? list : [...list, path]));
    if (files.length > FREE_FILES) {
      await update($, touched, (list) => list.filter((one) => one !== path));
      return {
        deny:
          `learning-mode: this is a bigger implementation step (more than ${FREE_FILES} file). ` +
          `Explain the plan, then call ${TOOL} with understanding questions and end your turn.`,
      };
    }

    return next(e);
  }).catch(($, e, next) => next(e));

  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e);
    const { Box, Text, Button } = elements;
    // Mobile draws no Input: the quiz is answered on the terminal or desktop.
    const Input = "Input" in elements ? elements.Input : undefined;
    const current = await read($, quiz);

    if (current === null) {
      return <Text dimColor>No quiz yet. Claude will post one before a bigger implementation step.</Text>;
    }

    const done = current.questions.filter((q) => q.verdict === "correct").length;
    const width = Math.max(20, e.props.bodyColumns);

    return (
      <Box flexDirection="column" width={width}>
        <Text bold>{current.title}</Text>
        <Text dimColor>
          {current.status === "pending"
            ? `Answer in your own words, Enter to submit. ${done}/${current.questions.length} correct.`
            : current.status === "passed"
              ? "All correct. Claude is continuing."
              : "Skipped."}
        </Text>
        {current.questions.map((q, i) => (
          <Box flexDirection="column" marginTop={1}>
            <Text>
              <Text color={colorOf(q)}>{markOf(q)}</Text> {i + 1}. {q.text}
            </Text>
            {q.answer !== "" && q.verdict !== "unanswered" && <Text dimColor> you: {q.answer}</Text>}
            {q.feedback !== "" && <Text color={colorOf(q)}> {q.feedback}</Text>}
            {current.status === "pending" && (q.verdict === "unanswered" || q.verdict === "incorrect") && Input && (
              <Input
                key={`answer:${i}`}
                label="> "
                placeholder={q.attempts === 0 ? "your answer" : "try again"}
                submitLabel="check"
                onSubmit={(text) => void check($, current.id, i, text)}
              />
            )}
          </Box>
        ))}
        {current.status !== "pending" && (
          <Box marginTop={1}>
            <Button key="close" label="Close" role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
          </Box>
        )}
      </Box>
    );
  });
};

type $ = EngineInterface;

function markOf(q: Question) {
  return q.verdict === "correct" ? "✓" : q.verdict === "incorrect" ? "✗" : q.verdict === "checking" ? "…" : "?";
}

function colorOf(q: Question) {
  return q.verdict === "correct" ? "green" : q.verdict === "incorrect" ? "red" : q.verdict === "checking" ? "yellow" : undefined;
}

async function openPane($: $, focus: boolean) {
  return $.ui.open(focus ? { id: PANE, title: "Learning mode", focus: true } : { id: PANE, title: "Learning mode" });
}

function setQuestion(id: string, index: number, patch: Partial<Question>) {
  return (q: Quiz | null) =>
    q === null || q.id !== id ? q : { ...q, questions: q.questions.map((one, i) => (i === index ? { ...one, ...patch } : one)) };
}

async function check($: $, id: string, index: number, text: string) {
  const answer = text.trim();
  if (answer === "") return;
  const before = await read($, quiz);
  const question = before?.questions[index];
  if (!before || before.id !== id || !question || question.verdict === "checking") return;

  await update($, quiz, setQuestion(id, index, { answer, verdict: "checking", feedback: "checking…" }));
  const { isCorrect, feedback } = await grade($, before.title, question.text, answer).catch(() => ({
    isCorrect: false,
    feedback: "Could not grade that answer. Press Enter to try again.",
  }));
  const after = await update(
    $,
    quiz,
    setQuestion(id, index, {
      verdict: isCorrect ? "correct" : "incorrect",
      feedback,
      attempts: question.attempts + 1,
    }),
  );

  if (after?.id === id && after.status === "pending" && after.questions.every((q) => q.verdict === "correct")) {
    await finish($, after, "passed");
  }
}

async function finish($: $, current: Quiz, status: "passed" | "skipped") {
  await update($, quiz, (q) => (q?.id === current.id ? { ...q, status } : q));
  await update($, cleared, () => true);
  $.ui.toast(status === "passed" ? "Learning check passed. Claude continues." : "Learning check skipped.");
  // Not awaited: it resolves only once the new turn starts, which a running command would block.
  void $.prompt.submit({
    text:
      status === "passed"
        ? `[learning-mode] I answered all understanding questions about "${current.title}" correctly. Continue with the implementation.`
        : `[learning-mode] I skipped the understanding check for "${current.title}". Continue with the implementation.`,
  });
}

const GRADER = `You are grading a learner's answer in "learning mode". The learner was asked a question about the implementation plan discussed in the conversation above.

Judge whether the answer shows correct high-level understanding, consistent with what is going to get built. Be lenient about wording, brevity and minor omissions; be fairly strict about misconceptions, wrong responsibilities, or vague answers that dodge the question.

Reply with ONLY a single line of JSON, no prose around it:
{"correct": true|false, "feedback": "<one short sentence. If correct, a brief confirmation or nuance. If incorrect, a hint that points them in the right direction WITHOUT giving the answer away.>"}`;

async function grade($: $, title: string, question: string, answer: string) {
  const prompt = `${GRADER}\n\nTopic: ${title}\nQuestion: ${question}\nLearner's answer: ${answer}`;
  let reply = await $.model.fork({ prompt });
  if (!reply.isAnswered && reply.reason === "nothing-to-fork") {
    reply = await $.model.complete({ model: "sonnet", prompt, maxTokens: 300 });
  }
  if (!reply.isAnswered) {
    return { isCorrect: false, feedback: `Could not grade (${reply.reason}). Press Enter on an answer to try again.` };
  }

  return parseVerdict(reply.text);
}

export function parseVerdict(text: string) {
  const match = text.match(/\{[\s\S]*\}/);
  try {
    const parsed = JSON.parse(match ? match[0] : text) as { correct?: unknown; feedback?: unknown };
    return {
      isCorrect: parsed.correct === true,
      feedback: typeof parsed.feedback === "string" ? parsed.feedback : "",
    };
  } catch {
    return { isCorrect: false, feedback: "Could not read the grader’s verdict. Try again." };
  }
}
