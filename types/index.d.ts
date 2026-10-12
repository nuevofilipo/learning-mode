export type Verdict = 'unanswered' | 'checking' | 'correct' | 'incorrect'

export type Question = {
  text: string
  answer: string
  verdict: Verdict
  feedback: string
  attempts: number
}

export type Quiz = {
  id: string
  title: string
  questions: Question[]
  status: 'pending' | 'passed' | 'skipped'
}

declare module 'claude-code' {
  interface PluginState {
    'learning-mode': {
      enabled: boolean
      quiz: Quiz | null
      cleared: boolean
      touched: string[]
    }
  }
}
