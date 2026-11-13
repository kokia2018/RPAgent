import { createRoot } from 'react-dom/client'
import { AppErrorBoundary } from './ui/AppErrorBoundary'
import App from './App'
import { ToastProvider } from './ui/toast'
import './styles/global.css'

// 如果 Service Worker 没有接管 /__vfs__/，开发服务器可能把入口 HTML 回退给 iframe。
// 这里阻止工作台在试玩 iframe 里递归加载自己。
if (location.pathname.startsWith('/__vfs__/')) {
  document.body.innerHTML =
    '<pre style="padding:24px;font:14px/1.6 monospace;color:#8c352c">试玩虚拟源未就绪：Service Worker 没有接管 /__vfs__/。请刷新页面，或让工作台使用内联降级预览。</pre>'
} else {
  createRoot(document.getElementById('root')!).render(
    <AppErrorBoundary><ToastProvider>
      <App />
    </ToastProvider></AppErrorBoundary>,
  )
}
