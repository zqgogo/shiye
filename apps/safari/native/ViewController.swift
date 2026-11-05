import Cocoa
import SafariServices
import WebKit
let extensionBundleIdentifier = "dev.shiye.bookmarks.Extension"
final class ViewController: NSViewController {
    @IBOutlet var webView: WKWebView!
    private let status = NSTextField(wrappingLabelWithString: "正在检测 Safari 扩展状态…")
    override func viewDidLoad() {
        super.viewDidLoad()
        webView.removeFromSuperview()
        let title = NSTextField(labelWithString: "拾页 · Safari")
        title.font = .systemFont(ofSize: 25, weight: .semibold)
        status.font = .systemFont(ofSize: 14)
        let settings = NSButton(title: "打开 Safari 扩展设置", target: self, action: #selector(openSettings))
        settings.bezelStyle = .rounded
        let help = NSTextField(wrappingLabelWithString: "1. 在 Safari 设置的“扩展”中勾选拾页。\n2. 点击工具栏的拾页图标，可收藏当前页或进入工作台。\n3. 与 Chrome 本地库独立，迁移请用 JSON 备份，或连接同一 Cloudflare 同步收藏。")
        help.font = .systemFont(ofSize: 14)
        let note = NSTextField(wrappingLabelWithString: "本机开发包需要允许未签名扩展；Safari 重启后可能需重新允许。\n此包不含账号、AI Key 或收藏数据，不默认访问所有网站。")
        note.font = .systemFont(ofSize: 12); note.textColor = .secondaryLabelColor
        let stack = NSStackView(views: [title, status, settings, help, note])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 18
        stack.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 28), stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -28), stack.topAnchor.constraint(equalTo: view.topAnchor, constant: 28), stack.bottomAnchor.constraint(lessThanOrEqualTo: view.bottomAnchor, constant: -28)])
        refreshState()
        NotificationCenter.default.addObserver(self, selector: #selector(refreshState), name: NSApplication.didBecomeActiveNotification, object: nil)
    }
    override func viewDidAppear() {
        super.viewDidAppear(); view.window?.setContentSize(NSSize(width: 560, height: 440))
    }
    deinit { NotificationCenter.default.removeObserver(self) }
    @objc private func refreshState() {
        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier) { state, error in
            DispatchQueue.main.async {
                if let state = state { self.status.stringValue = state.isEnabled ? "拾页扩展已启用，点击 Safari 工具栏图标即可使用。" : "拾页扩展尚未启用，请打开 Safari 扩展设置。" }
                else if let error = error { self.status.stringValue = "Safari 暂未确认扩展注册（\((error as NSError).code)）。请先允许本地开发扩展，再打开 Safari 扩展设置。" }
            }
        }
    }
    @objc private func openSettings() {
        SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { error in
            DispatchQueue.main.async { if let error = error { self.status.stringValue = "Safari 设置打开失败：\(error.localizedDescription)" } else { self.refreshState() } }
        }
    }
}
