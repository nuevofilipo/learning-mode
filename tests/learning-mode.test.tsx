import { expect, mock, test } from 'claude-code/testing'

import { parseVerdict } from '../hooks/register'

const TOOL = 'mcp__learning-mode__quiz'

type On = Parameters<Exclude<Parameters<typeof test>[1], { timeoutMs?: number }>>[1]

function refusal(r: { deny?: string; isError?: boolean; text?: string }) {
  return r.deny ?? (r.isError ? r.text ?? '' : undefined)
}

async function start($: any, on: On) {
  mock.store(on)
  on('session.start', async ($, e) => ({ cwd: e.cwd }) as never)
  on('command.register', async () => ({ value: {} }) as never)
  on('tool.register', async () => ({ value: { tool: TOOL } }) as never)
  on('tool.call', async () => ({ result: 'ok' }))
  for (const op of ['ui.open', 'ui.close', 'ui.status', 'ui.toast'] as const) {
    on(op, async () => ({ value: op === 'ui.open' ? { isPlaced: true } : undefined }) as never)
  }
  await $.session.start({ source: 'startup', cwd: '/tmp/project' })
}

test('quiz blocks edits until every answer is graded correct, then resumes Claude', async ($, on) => {
  const submitted: string[] = []
  let verdict = '{"correct": false, "feedback": "Think about who owns the cache."}'
  on('model.fork', async () => ({ value: { isAnswered: true, text: verdict, usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }) as never)
  on('prompt.submit', async ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  await start($, on)
  const toggled = await $.command.run({ command: 'learning-mode', args: 'on' } as never)
  expect(toggled.text).toContain('Learning mode on')

  const shown = await $.tool.call({ tool: TOOL, title: 'Cache layer', questions: ['Why a cache?', 'Who invalidates it?'] } as never)
  expect(String(shown.text ?? shown.result)).toContain('End your turn')

  const blocked = await $.tool.call({ tool: 'Write', file_path: 'a.ts', content: 'x' } as never)
  expect(refusal(blocked as never)).toContain('learning-mode')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'learning-mode',
      surface,
      component: 'Pane',
      requestId: 'learning-mode',
      props: { title: 'Learning mode', isFocused: true, bodyColumns: 60, placement: 'dock' } as never,
    })
    expect(await ui.find({ type: 'Text', text: /Cache layer/ })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({
    plugin: 'learning-mode',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'learning-mode',
    props: { title: 'Learning mode', isFocused: true, bodyColumns: 60, placement: 'dock' } as never,
  })
  await ui.input({ key: 'answer:0', text: 'no idea' })
  expect(await ui.find({ type: 'Text', text: /who owns the cache/ })).toBeDefined()
  expect(submitted).toEqual([])

  verdict = '{"correct": true, "feedback": "Right."}'
  await ui.input({ key: 'answer:0', text: 'to avoid repeated slow DB reads' })
  await ui.input({ key: 'answer:1', text: 'the write path invalidates on update' })
  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain('Continue with the implementation')

  const allowed = await $.tool.call({ tool: 'Write', file_path: 'b.ts', content: 'y' } as never)
  expect(refusal(allowed as never)).toBeUndefined()
  await ui.unmount()
})

test('without a quiz, a second file is refused as a bigger step', async ($, on) => {
  await start($, on)
  await $.command.run({ command: 'learning-mode', args: 'on' } as never)

  const first = await $.tool.call({ tool: 'Edit', file_path: 'a.ts', old_string: 'a', new_string: 'b' } as never)
  expect(refusal(first as never)).toBeUndefined()
  const second = await $.tool.call({ tool: 'Edit', file_path: 'b.ts', old_string: 'a', new_string: 'b' } as never)
  expect(refusal(second as never)).toContain('bigger implementation step')
})

test('off lets every edit through', async ($, on) => {
  await start($, on)
  await $.command.run({ command: 'learning-mode', args: 'off' } as never)
  for (const path of ['a.ts', 'b.ts', 'c.ts']) {
    const r = await $.tool.call({ tool: 'Write', file_path: path, content: 'x' } as never)
    expect(refusal(r as never)).toBeUndefined()
  }
})

test('parseVerdict reads JSON with prose around it', () => {
  expect(parseVerdict('Sure: {"correct": true, "feedback": "ok"}')).toEqual({ isCorrect: true, feedback: 'ok' })
  expect(parseVerdict('garbage').isCorrect).toBe(false)
})
