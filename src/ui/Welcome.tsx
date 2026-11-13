import { Icon } from './icons'

export function Welcome({
  hasApi,
  onCreate,
  onSettings,
}: {
  hasApi: boolean
  onCreate: () => void
  onSettings: () => void
}) {
  return (
    <div className="welcome">
      <div className="welcome-inner">
        <div className="welcome-mark">
          <Icon name="spark" size={26} />
        </div>
        <p className="welcome-kicker">浏览器里的 AI 开发工作台</p>
        <h1>
          描述一个想法，
          <br />
          让 Agent 把它做成能跑的网页。
        </h1>
        <p className="welcome-desc">
          Agent 会在独立工作区创建文件，在试玩区运行，读取真实错误并修改，
          最后导出可独立打开的单 HTML。所有数据保存在本机 IndexedDB。
        </p>
        <div className="welcome-actions">
          <button className="btn btn-primary btn-large" onClick={onCreate}>
            <Icon name="plus" size={16} /> 新建任务
          </button>
          <button className="btn btn-ghost btn-large" onClick={onSettings}>
            <Icon name="settings" size={16} /> {hasApi ? '模型设置' : '先配置模型'}
          </button>
        </div>
        <div className="welcome-steps">
          {[
            ['配置模型', 'OpenAI 兼容端点，密钥只存本机'],
            ['描述需求', 'Agent 真实写文件，不是只给代码'],
            ['试玩修复', '读取 console、异常和网络失败'],
            ['导出交付', '单 HTML，检查依赖与密钥'],
          ].map(([title, desc], i) => (
            <div key={title} className="welcome-step">
              <span className="welcome-step-index">{i + 1}</span>
              <strong>{title}</strong>
              <span>{desc}</span>
            </div>
          ))}
        </div>
        {!hasApi ? (
          <div className="welcome-note">
            <Icon name="warning" size={14} />
            <span>还没有配置模型。先打开设置填写 Base URL、Key 和模型名。</span>
          </div>
        ) : null}
      </div>
    </div>
  )
}
