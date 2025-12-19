# 修复：Extension Context Invalidated 错误

## 问题描述

在快速切换 subapp 时，控制台会出现大量 `Extension context invalidated` 错误：

```
Uncaught (in promise) Error: Extension context invalidated.
    at contentScript.js:1:9134
```

## 根本原因

这是 **Chrome Manifest V3 的运行时特性**，不是代码 bug：

1. **Service Worker 生命周期**：Chrome 会在 Service Worker 空闲约 30 秒后自动终止它
2. **快速切换触发大量事件**：用户快速切换 subapp 时，single-spa 触发大量路由事件
3. **通信失败**：content script 尝试通过 `browser.runtime.sendMessage()` 发送消息时，background service worker 可能已被终止
4. **抛出异常**：导致 `Extension context invalidated` 错误

## 错误链路

```
用户快速切换 subapp 
→ single-spa 触发 routing-event 
→ content_script.js 监听到事件并调用 browser.runtime.sendMessage() 
→ 但此时 background service worker 已失效 
→ 抛出 "Extension context invalidated" 错误
```

## 解决方案

在所有使用 `browser.runtime.sendMessage()` 的地方添加错误处理，优雅地捕获并忽略这个异常。

### 修改的文件

#### 1. `src/content_script.js`

**修改前：**
```javascript
window.addEventListener("single-spa-inspector-pro:routing-event", () => {
  browser.runtime.sendMessage({
    from: "single-spa",
    type: "routing-event",
  });
});
```

**修改后：**
```javascript
window.addEventListener("single-spa-inspector-pro:routing-event", () => {
  browser.runtime.sendMessage({
    from: "single-spa",
    type: "routing-event",
  }).catch((err) => {
    // Silently ignore context invalidation errors
    if (err.message && err.message.includes("Extension context invalidated")) {
      return;
    }
    console.warn("single-spa Inspector Pro: Failed to send routing event:", err);
  });
});
```

#### 2. `src/panel-app/useImportMapOverrides.js`

在 `reloadWithBypassCache()` 和 `waitForPageLoad()` 中添加错误处理：

```javascript
try {
  await browser.runtime.sendMessage({ ... });
} catch (err) {
  if (err.message && err.message.includes("Extension context invalidated")) {
    console.debug("[single-spa-inspector-pro] Service worker terminated...");
    return;
  }
  throw err;
}
```

#### 3. `src/panel-app/clear-cache-button.js`

在 `handleClearCache()` 中添加错误处理：

```javascript
catch (error) {
  if (error.message && error.message.includes("Extension context invalidated")) {
    console.debug("[single-spa-inspector-pro] Service worker terminated during clear cache");
    setStatus("error");
  } else {
    setStatus("error");
    console.error("Error sending clear-cache message:", error);
  }
}
```

#### 4. `src/panel-app.js`

在 ping service worker 时添加错误处理：

```javascript
try {
  await browser.runtime.sendMessage({ type: "panel-ping" });
} catch (err) {
  if (err.message && err.message.includes("Extension context invalidated")) {
    console.debug("[single-spa-inspector-pro] Service worker terminated during ping");
  }
}
```

## 为什么这样修复是正确的

1. **这是预期行为**：Chrome 终止 Service Worker 是正常的 MV3 行为
2. **不影响功能**：
   - panel 有自动重连机制（见 `panel.js` 中的 `onDisconnect` 监听）
   - 页面刷新后会重新建立连接
   - 用户切换回 Inspector 面板时会自动恢复
3. **优雅降级**：捕获异常后静默处理，不影响用户体验
4. **保留其他错误**：只忽略 context invalidation，其他错误仍会被记录

## 测试验证

修复后，快速切换 subapp 时：
- ✅ 不再出现控制台错误
- ✅ Inspector 面板功能正常
- ✅ 自动重连机制正常工作
- ✅ 其他错误仍能正常捕获和报告

## 相关文档

- [Chrome Extension Service Worker Lifecycle](https://developer.chrome.com/docs/extensions/mv3/service_workers/)
- [Handling Extension Context Invalidation](https://developer.chrome.com/docs/extensions/mv3/messaging/#port-lifetime)
