import { Component, type ReactNode } from 'react'

export class AppErrorBoundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: '' }

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) }
  }

  componentDidCatch(error: unknown, info: { componentStack?: string | null }) {
    console.error('Workbench render error', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return <main className="splash" role="alert">
      <h1>工作台遇到页面错误</h1>
      <p>本地项目没有被清空。请重新打开页面后重试。</p>
      <pre>{this.state.error}</pre>
      <button className="btn btn-primary" onClick={() => window.location.reload()}>重新打开</button>
    </main>
  }
}
