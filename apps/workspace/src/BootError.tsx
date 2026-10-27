export function BootError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div style={{ maxWidth: 640, margin: '80px auto', padding: '0 24px' }}>
      <div className="eyebrow">SHIYE / STORAGE</div>
      <h1 style={{ font: '30px Georgia, serif', margin: '10px 0' }}>主库未能打开</h1>
      <p className="micro">
        扩展没有创建空库来掩盖错误。请先导出或保留现有浏览器数据，确认磁盘空间与浏览器权限后重试。
      </p>
      <div className="notice danger" style={{ overflowWrap: 'anywhere' }}>
        {message}
      </div>
      <div className="actions" style={{ justifyContent: 'flex-start' }}>
        <button className="btn primary" onClick={onRetry}>
          重新尝试
        </button>
        <button className="btn" onClick={() => window.location.reload()}>
          刷新页面
        </button>
      </div>
      <p className="micro" style={{ marginTop: 16 }}>
        如果问题来自版本升级，请保留原库并记录错误信息，不要删除浏览器站点数据。
      </p>
    </div>
  );
}
