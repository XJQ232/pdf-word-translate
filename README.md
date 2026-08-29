# PDF 划词翻译

PDF 划词翻译是一个 VS Code PDF 阅读扩展。它可以在 PDF 中渲染可选择的文本层，选中文本后自动弹出翻译结果，适合阅读论文、技术文档和英文教材。

## 功能

- 在 VS Code 中打开 PDF 文件
- 支持 PDF 文本划选
- 划词后自动翻译
- 翻译浮窗显示实际使用的服务
- 支持翻页、缩放、适应宽度
- 每次打开 PDF 自动适应宽度
- 按住 `Ctrl` 并滚动鼠标滚轮可以放大或缩小
- 可以用工具栏 `Highlight` 按钮开启或关闭自动高亮
- 可以在工具栏选择高亮颜色
- 选中文本后按默认快捷键 `Ctrl+H` 可以添加高亮
- 再次选中已高亮文本并按 `Ctrl+H` 可以取消高亮
- 选中文本后按默认快捷键 `Ctrl+P` 可以把翻译内容作为备注框放在选区附近
- 备注框可以用鼠标拖动位置
- 按 `Ctrl+Z` 可以撤销最近一次高亮或备注操作
- 按 `Ctrl+S` 或工具栏 `Save` 可以保存高亮和备注，下次打开同一个 PDF 会恢复
- 高亮透明度和备注透明度都可以用滑杆调整
- 目标语言和源语言使用下拉选项
- API 服务按优先级自动尝试
- API 密钥保存到 VS Code SecretStorage，不写入 `settings.json`

## 翻译优先级

插件按下面顺序尝试翻译：

1. 百度翻译
2. 腾讯云机器翻译
3. OpenAI
4. MyMemory 公共接口

没有配置密钥的服务会自动跳过。某个服务调用失败时，插件会继续尝试下一个服务。如果所有付费/私有 API 都没有配置，就使用 MyMemory 作为默认兜底。

## 安装

从本地 VSIX 安装：

```powershell
code --install-extension .\pdf-word-translate-0.2.9.vsix --force
```

安装后执行命令：

```text
Developer: Reload Window
```

## 使用方法

1. 在 VS Code 中打开一个 `.pdf` 文件。
2. 如果没有自动使用本插件，点击编辑器右上角的打开方式，选择 `PDF Translate Viewer`。
3. 在 PDF 页面中用鼠标选中文本。
4. 等待翻译浮窗显示结果。
5. 需要高亮时，点击工具栏 `Highlight` 开关，或按高亮快捷键。
6. 已有高亮再次被选中时，按高亮快捷键或开启 Highlight 后选中它，可以取消高亮。
7. 需要把翻译结果贴到页面旁边时，按备注快捷键。
8. 备注框可以直接拖动调整位置。
9. 按 `Ctrl+S` 或工具栏 `Save` 保存标注。
10. 点击工具栏的 `Settings` 可以调整语言、快捷键、高亮透明度、备注透明度、启用或关闭某个翻译服务。
11. 高亮和备注改变后，按 `Ctrl+S` 或点击 `Save` 保存到本机。

## 标注保存位置

高亮和备注会保存到 PDF 文件同目录下的 `pdf-annotations` 文件夹中。

例如打开：

```text
D:\papers\example.pdf
```

保存后会生成：

```text
D:\papers\pdf-annotations\example.annotations.json
```

这个 JSON 文件保存高亮位置、颜色、透明度、备注位置和备注内容。插件不会把标注直接写进 PDF 文件本体。

## 配置 API

打开 VS Code 命令面板，执行下面的命令：

```text
PDF Translate Viewer: Configure Baidu Translate
PDF Translate Viewer: Configure Tencent Translate
PDF Translate Viewer: Configure OpenAI Translate
PDF Translate Viewer: Clear Translator API Keys
```

### 百度翻译

需要填写：

- App ID
- Secret Key

插件使用百度通用翻译 API。配置完成后，只要 `Baidu Translate` 开关开启，就会优先使用百度。

### 腾讯翻译

需要填写：

- SecretId
- SecretKey
- 腾讯云地域

地域通过下拉选择，默认是 `ap-guangzhou`。

### OpenAI

需要填写：

- OpenAI API Key

模型通过下拉选择，默认是 `gpt-4.1-mini`。

## 常用设置

这些设置可以在 PDF 顶部 `Settings` 面板中调整：

- Source language：源语言
- Target language：目标语言
- Baidu Translate：是否启用百度
- Tencent Translate：是否启用腾讯
- OpenAI：是否启用 OpenAI
- OpenAI model：OpenAI 模型
- Highlight shortcut：高亮快捷键
- Note shortcut：备注快捷键
- Highlight color：高亮颜色
- Highlight opacity：高亮透明度，滑杆调整
- Note opacity：备注透明度
- Max selection length：单次翻译最大字符数

## 开发

在项目目录运行检查：

```powershell
npm run check
```

打包 VSIX：

```powershell
powershell -ExecutionPolicy Bypass -File .\package-vsix.ps1
```

## 说明

当前高亮和备注会保存为 PDF 同目录 `pdf-annotations` 文件夹里的 JSON 文件，不会写回 PDF 文件本体。当前 PDF.js 从 CDN 加载，因此首次打开 PDF 时需要网络访问 `cdn.jsdelivr.net`。翻译服务也需要对应 API 的网络访问权限。

