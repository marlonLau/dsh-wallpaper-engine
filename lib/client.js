/**
 * dsh-wallpaper-engine — client half (web).
 *
 * One-click background switcher for the DSH Web GUI, backed by local
 * Wallpaper Engine content served by this plugin's host half:
 *   /we/list (wallpaper list), /we/preview + /we/file (media), /we/config.
 *
 * Rendering strategy (kept deliberately dependency-free):
 *   · a fixed background layer (#dsh-we-bg, z-index 0) sits behind the app;
 *   · the app frame's own background is forced transparent via CSS
 *     (`#root [data-slot="root"] > div`), so the wallpaper shows through at
 *     full strength without relying on theme-token overrides;
 *   · images preload-checked (full-res file first, preview fallback);
 *   · videos play muted/looping with a watchdog that falls back to the
 *     preview if playback never starts;
 *   · the sidebar keeps a cosmetic translucent token overlay (best effort).
 */
window.__ModuleLoader__.load({
  id: '@marlonlau/dsh-wallpaper-engine',
  factory: (require) => {
    'use strict'
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var inject = ['theme', 'workspaces']

    // ---- persisted prefs -------------------------------------------------------
    var KEY_CURRENT = 'dsh-we:current'
    var KEY_FOLLOW = 'dsh-we:followTheme'
    var LS = window.localStorage

    var themeService = null
    var workspaceService = null
    var state = {
      list: [], source: null, loading: false, error: null,
      current: null, follow: LS.getItem(KEY_FOLLOW) === '1',
      blurFill: LS.getItem('dsh-we:blurFill') === '1',
      open: false, apiReachable: null, extraDirs: [], desktopMsg: null,
    }
    var store = { listeners: [] }
    store.subscribe = function (fn) {
      store.listeners.push(fn)
      return function () { store.listeners = store.listeners.filter(function (x) { return x !== fn }) }
    }
    function notify() { for (var i = 0; i < store.listeners.length; i++) store.listeners[i]() }

    // ---- styles ---------------------------------------------------------------
    var CSS = [
      '#dsh-we-bg{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden;background-size:cover;background-position:center;background-repeat:no-repeat}',
      '#dsh-we-bg video{width:100%;height:100%;object-fit:cover;display:block}',
      '#dsh-we-scrim{position:absolute;inset:0;background:rgba(6,9,14,0.12)}',
      '#dsh-we-fill{position:absolute;inset:0;display:none;background-size:cover;background-position:center;background-repeat:no-repeat;filter:blur(32px);transform:scale(1.1)}',
      '#dsh-we-main{position:absolute;inset:0;display:none;background-size:contain;background-position:center;background-repeat:no-repeat}',
      'body[data-dsh-we="on"] #root{position:relative;z-index:1}',
      'body[data-dsh-we="on"] #root [data-slot="root"] > div{background:transparent !important}',
      // translucent surface tokens: every container that paints var(--dsw-alias-bg-base)
      // (app frame, conversation, details) or var(--dsw-specific-sidebar-fill) (left
      // sidebar, dsh-better-sidebar right/bottom panels) becomes see-through
      'body[data-dsh-we="on"]{--dsw-alias-bg-base:rgba(16,20,27,0.42) !important;--dsw-specific-sidebar-fill:rgba(16,20,27,0.5) !important}',
      'body[data-dsh-we="on"][data-ds-dark-theme]{--dsw-alias-bg-base:rgba(9,12,18,0.42) !important;--dsw-specific-sidebar-fill:rgba(9,12,18,0.5) !important}',
      'body[data-dsh-we="on"]:not([data-ds-dark-theme]){--dsw-alias-bg-base:rgba(238,241,246,0.45) !important;--dsw-specific-sidebar-fill:rgba(238,241,246,0.55) !important}',
      '#dsh-we-chip{position:fixed;width:40px;height:40px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2,#2a3040);background:var(--dsw-alias-bg-overlay,rgba(20,24,32,0.92));color:var(--dsw-alias-label-primary,#e6edf3);font-size:18px;cursor:grab;z-index:110;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(0,0,0,0.35);padding:0;line-height:1;touch-action:none;user-select:none}',
      '#dsh-we-chip:active{cursor:grabbing}',
      '#dsh-we-chip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,0.1))}',
      '#dsh-we-chip.we-on{border-color:var(--dsw-alias-brand-primary,#4f8cff);box-shadow:0 0 0 1px var(--dsw-alias-brand-primary,#4f8cff)}',
      '#dsh-we-panel{position:fixed;width:356px;max-height:min(72vh,640px);display:none;flex-direction:column;background:var(--dsw-alias-bg-overlay,rgba(20,24,32,0.97));border:1px solid var(--dsw-alias-border-l2,#2a3040);border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,0.45);z-index:120;overflow:hidden;font-size:13px;color:var(--dsw-alias-label-primary,#e6edf3);font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif}',
      '#dsh-we-panel.we-open{display:flex}',
      '.we-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l2,#2a3040);flex:none}',
      '.we-head b{font-size:14px;font-weight:600}',
      '.we-src{font-size:11px;color:var(--dsw-alias-label-secondary,#9aa4b2);background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,0.06));border-radius:6px;padding:2px 7px}',
      '.we-head .we-close{margin-left:auto;background:none;border:none;color:var(--dsw-alias-label-secondary,#9aa4b2);cursor:pointer;font-size:15px;padding:2px 6px;border-radius:6px}',
      '.we-head .we-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,0.08));color:var(--dsw-alias-label-primary,#e6edf3)}',
      '.we-toolbar{display:flex;align-items:center;gap:6px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,#232937);flex:none;flex-wrap:wrap}',
      '.we-toolbar.we-opts{padding:6px 12px 8px;gap:12px}',
      '.we-toolbar button{background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,0.06));border:1px solid var(--dsw-alias-border-l1,#232937);color:var(--dsw-alias-label-primary,#e6edf3);border-radius:8px;padding:4px 10px;font-size:12px;cursor:pointer;line-height:1.4}',
      '.we-toolbar button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,0.1))}',
      '.we-toolbar button.we-on{border-color:var(--dsw-alias-brand-primary,#4f8cff);color:var(--dsw-alias-brand-primary,#4f8cff)}',
      '.we-toolbar .we-follow{display:flex;align-items:center;gap:5px}',
      '.we-toolbar .we-follow input{margin:0}',
      '.we-msg{padding:5px 12px 0;font-size:11px;color:var(--dsw-alias-label-secondary,#9aa4b2);flex:none;display:none;line-height:1.5}',
      '.we-msg.we-show{display:block}',
      '.we-body{overflow-y:auto;padding:10px 12px;flex:1}',
      '.we-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
      '.we-card{position:relative;border:1px solid var(--dsw-alias-border-l2,#2a3040);border-radius:10px;overflow:hidden;cursor:pointer;background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,0.04));transition:border-color .12s ease}',
      '.we-card:hover{border-color:var(--dsw-alias-brand-primary,#4f8cff)}',
      '.we-card.we-current{border-color:var(--dsw-alias-brand-primary,#4f8cff);box-shadow:0 0 0 1px var(--dsw-alias-brand-primary,#4f8cff)}',
      '.we-card img{width:100%;aspect-ratio:16/9;object-fit:cover;display:block;background:#0b0e14}',
      '.we-card .we-ttl{position:absolute;left:0;right:0;bottom:0;padding:14px 6px 5px;font-size:11px;line-height:1.35;color:#fff;background:linear-gradient(transparent,rgba(0,0,0,0.75));overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.we-card .we-kind{position:absolute;top:5px;right:5px;font-size:10px;background:rgba(0,0,0,0.55);color:#cfe0ff;border-radius:5px;padding:1px 6px}',
      '.we-empty,.we-error{padding:18px 8px;text-align:center;color:var(--dsw-alias-label-secondary,#9aa4b2);font-size:12px;line-height:1.7}',
      '.we-error{color:var(--dsw-alias-state-error-primary,#f56c6c)}',
      '.we-empty-actions{display:flex;justify-content:center;padding:2px 0 12px}',
      '.we-empty-actions button{background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,0.08));border:1px solid var(--dsw-alias-border-l1,#232937);color:var(--dsw-alias-label-primary,#e6edf3);border-radius:8px;padding:5px 14px;cursor:pointer;font-size:12px}',
      '.we-config{border-top:1px solid var(--dsw-alias-border-l1,#232937);padding:9px 12px 11px;flex:none;font-size:12px}',
      '.we-config .we-cfg-title{color:var(--dsw-alias-label-secondary,#9aa4b2);margin-bottom:0;cursor:pointer;user-select:none}',
      '.we-config .we-cfg-title:hover{color:var(--dsw-alias-label-primary,#e6edf3)}',
      '#dsh-we-dirpop{position:fixed;inset:0;z-index:200;display:none;align-items:center;justify-content:center}',
      '#dsh-we-dirpop.we-open{display:flex}',
      '#dsh-we-dirpop .we-pop-backdrop{position:absolute;inset:0;background:rgba(10,14,20,0.45)}',
      '#dsh-we-dirpop .we-pop{position:relative;box-sizing:border-box;width:440px;max-width:calc(100vw - 48px);background:var(--dsw-alias-bg-overlay,rgba(22,26,34,0.98));border:1px solid var(--dsw-alias-border-l2,#2a3040);border-radius:14px;box-shadow:0 16px 48px rgba(0,0,0,0.5);padding:14px;display:flex;flex-direction:column;gap:10px;font-size:13px;color:var(--dsw-alias-label-primary,#e6edf3);font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif}',
      '#dsh-we-dirpop .we-pop-head{display:flex;align-items:center;justify-content:space-between;font-weight:600}',
      '#dsh-we-dirpop .we-pop-close{background:none;border:none;color:var(--dsw-alias-label-secondary,#9aa4b2);cursor:pointer;font-size:14px;padding:2px 6px;border-radius:6px}',
      '#dsh-we-dirpop .we-pop-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,0.08))}',
      '#dsh-we-dirpop .we-dirtable{display:flex;flex-direction:column;gap:4px;max-height:180px;overflow-y:auto}',
      '#dsh-we-dirpop .we-dirrow{display:flex;align-items:center;gap:8px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,0.05));border:1px solid var(--dsw-alias-border-l1,#232937);border-radius:8px;padding:5px 8px}',
      '#dsh-we-dirpop .we-dirpath{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:Consolas,"Cascadia Mono",monospace;font-size:11px;color:var(--dsw-alias-label-primary,#e6edf3)}',
      '#dsh-we-dirpop .we-dirrow button{flex:none;background:none;border:none;color:var(--dsw-alias-state-error-primary,#f56c6c);cursor:pointer;font-size:12px;padding:0 4px}',
      '#dsh-we-dirpop .we-dir-empty{padding:8px;color:var(--dsw-alias-label-secondary,#9aa4b2);font-size:12px;text-align:center}',
      '#dsh-we-dirpop .we-addrow{display:flex;gap:6px}',
      '#dsh-we-dirpop input{background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,0.06));border:1px solid var(--dsw-alias-border-l1,#232937);color:var(--dsw-alias-label-primary,#e6edf3);border-radius:8px;padding:5px 9px;font-size:12px;outline:none;flex:1;min-width:0;width:auto;box-sizing:border-box}',
      '#dsh-we-dirpop .we-addrow button{flex:none;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,0.08));color:var(--dsw-alias-label-primary,#e6edf3);border:1px solid var(--dsw-alias-border-l1,#232937);border-radius:8px;padding:4px 10px;cursor:pointer;font-size:12px;white-space:nowrap}',
    ].join('')

    // ---- background layer -------------------------------------------------------
    var bgEl = null
    var fillEl = null
    var mainEl = null
    var scrimEl = null
    var videoEl = null
    var watchTimer = null
    var styleEl = null
    var panelEl = null
    var dirPopEl = null
    var chipEl = null
    var CHIP_KEY = 'dsh-we:chipPos'

    function ensureBg() {
      if (bgEl) return
      bgEl = document.createElement('div')
      bgEl.id = 'dsh-we-bg'
      fillEl = document.createElement('div')
      fillEl.id = 'dsh-we-fill'
      mainEl = document.createElement('div')
      mainEl.id = 'dsh-we-main'
      scrimEl = document.createElement('div')
      scrimEl.id = 'dsh-we-scrim'
      bgEl.appendChild(fillEl)
      bgEl.appendChild(mainEl)
      bgEl.appendChild(scrimEl)
    }
    function mediaUrl(p) { return p ? '/we/file?p=' + encodeURIComponent(p) : '' }
    function previewUrl(p) { return p ? '/we/preview?p=' + encodeURIComponent(p) : '' }

    /** Probe image sources in order; call done(url) with the first that loads. */
    function loadBackground(urls, done) {
      var seen = {}
      var i = 0
      function next() {
        while (i < urls.length) {
          var u = urls[i++]
          if (!u || seen[u]) continue
          seen[u] = true
          var img = new Image()
          img.onload = function () { done(u) }
          img.onerror = function () { next() }
          img.src = u
          return
        }
        done(null)
      }
      next()
    }

    function clearWatch() {
      if (watchTimer) { clearTimeout(watchTimer); watchTimer = null }
    }
    function fallbackToPreview(pUrl) {
      if (videoEl) { videoEl.pause(); videoEl.removeAttribute('src'); videoEl.style.display = 'none' }
      if (pUrl) applyImage("url('" + pUrl + "')")
    }
    /** Show an image URL: blurred-fill mode uses fill+contain layers, otherwise full-bleed cover. */
    function applyImage(url) {
      if (state.blurFill) {
        bgEl.style.backgroundImage = 'none'
        fillEl.style.backgroundImage = url
        mainEl.style.backgroundImage = url
        fillEl.style.display = 'block'
        mainEl.style.display = 'block'
      } else {
        fillEl.style.backgroundImage = 'none'
        mainEl.style.backgroundImage = 'none'
        fillEl.style.display = 'none'
        mainEl.style.display = 'none'
        bgEl.style.backgroundImage = url
      }
    }

    function applyWallpaper(entry, silent) {
      state.current = entry
      LS.setItem(KEY_CURRENT, JSON.stringify({ id: entry.id, title: entry.title, kind: entry.kind, file: entry.file, preview: entry.preview }))
      ensureBg()
      document.body.appendChild(bgEl)
      document.body.setAttribute('data-dsh-we', 'on')
      var mUrl = mediaUrl(entry.file)
      var pUrl = previewUrl(entry.preview)
      if (entry.kind === 'video' && mUrl) {
        bgEl.style.backgroundImage = 'none'
        fillEl.style.backgroundImage = 'none'
        mainEl.style.backgroundImage = 'none'
        fillEl.style.display = 'none'
        mainEl.style.display = 'none'
        if (!videoEl) {
          videoEl = document.createElement('video')
          videoEl.setAttribute('playsinline', '')
          videoEl.muted = true
          videoEl.loop = true
          videoEl.autoplay = true
          bgEl.appendChild(videoEl)
        }
        videoEl.style.display = 'block'
        videoEl.src = mUrl
        videoEl.onerror = function () { fallbackToPreview(pUrl) }
        videoEl.onplaying = clearWatch
        // watchdog: if playback never starts (unsupported codec etc.), show the preview
        clearWatch()
        watchTimer = setTimeout(function () {
          if (videoEl && videoEl.paused && pUrl) fallbackToPreview(pUrl)
        }, 3500)
      } else {
        clearWatch()
        if (videoEl) { videoEl.pause(); videoEl.removeAttribute('src'); videoEl.style.display = 'none' }
        var isRealImage = entry.kind === 'image' && mUrl && /\.(png|jpe?g|webp|gif|bmp)$/i.test(entry.file)
        var candidates = isRealImage ? [mUrl, pUrl] : [pUrl, mUrl]
        loadBackground(candidates, function (chosen) {
          if (!chosen) {
            console.warn('[dsh-wallpaper-engine] no background source loaded for', entry.title)
            return
          }
          var url = "url('" + chosen + "')"
          applyImage(url)
          console.log('[dsh-wallpaper-engine] applied', entry.title, '->', chosen)
          if (!silent && state.follow) followTheme(chosen)
        })
      }
      if (panelEl) renderList()
      syncChip()
      notify()
    }

    function clearWallpaper() {
      state.current = null
      LS.removeItem(KEY_CURRENT)
      document.body.removeAttribute('data-dsh-we')
      clearWatch()
      clearTimeout(followTimer)
      followSeq += 1
      if (videoEl) { videoEl.pause(); videoEl.removeAttribute('src'); videoEl.style.display = 'none' }
      // fully tear down the background layer so nothing (scrim, layers) lingers
      // over the app — otherwise a leftover dark veil shows on light themes
      if (bgEl) { bgEl.remove(); bgEl = null; fillEl = mainEl = scrimEl = null; videoEl = null }
      if (panelEl) renderList()
      syncChip()
      notify()
    }

    // ---- theme follow -----------------------------------------------------------
    // Debounced + sequence-guarded: rapid wallpaper switches settle on the LAST
    // wallpaper's brightness, so a slow image from a previous pick can never flip
    // the theme back. Also re-asserts the target once, because the theme
    // preference write is revision-guarded and a rejected write rolls back to
    // the durable value (which is how "switch back to a light wallpaper" could
    // end up stuck on dark).
    var followTimer = null
    var followSeq = 0
    function followTheme(src) {
      if (!themeService) return
      var mySeq = ++followSeq
      clearTimeout(followTimer)
      followTimer = setTimeout(function () {
        var img = new Image()
        img.onload = function () {
          if (mySeq !== followSeq) return
          var target = null
          try {
            var w = 48
            var h = Math.max(1, Math.round((img.naturalHeight / img.naturalWidth) * w))
            var canvas = document.createElement('canvas')
            canvas.width = w
            canvas.height = h
            var x = canvas.getContext('2d')
            x.drawImage(img, 0, 0, w, h)
            var d = x.getImageData(0, 0, w, h).data
            var sum = 0
            for (var i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
            target = (sum / (w * h)) < 120 ? 'dark' : 'light'
          } catch (e) { /* keep the current theme if the image can't be measured */ }
          if (!target) return
          try { themeService.setTheme(target) } catch (e) { /* ignore */ }
          // durable-write races can roll the preference back — re-assert once
          setTimeout(function () {
            if (mySeq !== followSeq) return
            try {
              var cur = themeService.getTheme()
              if (cur.preference === target) return
              themeService.setTheme(target)
            } catch (e) { /* ignore */ }
          }, 900)
        }
        img.onerror = function () { /* keep the current theme on load failure */ }
        img.src = src
      }, 400)
    }

    // ---- list + status -----------------------------------------------------------
    function loadList(refresh) {
      state.loading = true
      state.error = null
      notify()
      fetch('/we/list' + (refresh ? '?source=auto&refresh=1' : ''), { cache: 'no-store' })
        .then(function (r) { return r.json() })
        .then(function (j) {
          if (!j || !j.ok) throw new Error((j && j.error) || 'bad response')
          state.list = j.entries || []
          state.source = j.source
          state.loading = false
          renderList()
          notify()
        })
        .catch(function (e) {
          state.loading = false
          state.error = String((e && e.message) || e)
          renderList()
          notify()
        })
    }
    function loadStatus() {
      fetch('/we/status', { cache: 'no-store' })
        .then(function (r) { return r.json() })
        .then(function (j) {
          if (!j || !j.ok) return
          state.apiReachable = !!j.api && j.api.reachable
          state.extraDirs = j.extraDirs || []
          renderStatus()
          if (dirPopEl) renderDirPop()
          notify()
        })
        .catch(function () { /* ignore */ })
    }
    function saveConfig(extraDirs) {
      fetch('/we/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ extraDirs: extraDirs }),
      }).then(function () { loadStatus(); loadList(true) }).catch(function () { /* ignore */ })
    }
    /** Open the Host's native folder picker and add the chosen directory. */
    function pickDir() {
      if (!workspaceService) { showMsg('目录选择不可用'); return }
      showMsg('请在弹出的系统对话框中选择文件夹…')
      workspaceService.pickDirectory()
        .then(function (path) {
          if (!path) { showMsg('已取消选择'); return }
          var dirs = state.extraDirs.slice()
          if (dirs.indexOf(path) < 0) {
            dirs.push(path)
            state.extraDirs = dirs
            renderDirPop()
          }
          saveConfig(dirs)
        })
        .catch(function (e) { showMsg('选择失败：' + ((e && e.message) || e)) })
    }
    /** Add the directory typed into the popup input (Enter key). */
    function addDirInput() {
      if (!dirPopEl) return
      var input = dirPopEl.querySelector('[data-cfg-dir]')
      if (!input) return
      var v = (input.value || '').trim()
      if (!v) return
      var dirs = state.extraDirs.slice()
      if (dirs.indexOf(v) < 0) {
        dirs.push(v)
        state.extraDirs = dirs
      }
      saveConfig(dirs)
      input.value = ''
      renderDirPop()
    }
    var msgTimer = null
    function showMsg(text) {
      var targets = []
      if (panelEl) { var m1 = panelEl.querySelector('.we-msg'); if (m1) targets.push(m1) }
      if (dirPopEl) { var m2 = dirPopEl.querySelector('.we-msg'); if (m2) targets.push(m2) }
      if (!targets.length) return
      for (var i = 0; i < targets.length; i++) {
        targets[i].textContent = text
        targets[i].classList.add('we-show')
      }
      if (msgTimer) clearTimeout(msgTimer)
      msgTimer = setTimeout(function () {
        for (var j = 0; j < targets.length; j++) targets[j].classList.remove('we-show')
      }, 4000)
    }

    // ---- panel --------------------------------------------------------------------
    function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] }) }
    function kindLabel(k, type) {
      if (k === 'video') return '视频'
      if (k === 'image') return '图片'
      if (type === 'scene') return '3D场景'
      if (type === 'web') return '网页'
      if (type === 'application') return '应用'
      return '预览'
    }

    function renderList() {
      if (!panelEl) return
      var body = panelEl.querySelector('.we-body')
      if (!body) return
      if (state.loading) { body.innerHTML = '<div class="we-empty">加载中…</div>'; return }
      if (state.error) { body.innerHTML = '<div class="we-error">' + esc(state.error) + '</div>'; return }
      if (!state.list.length) {
        body.innerHTML = '<div class="we-empty">没有找到 Wallpaper Engine 壁纸。<br>插件会先自动识别本机 Steam 创意工坊（appid 431960）与本地项目，<br>识别不到时可手动添加壁纸文件夹。</div>' +
          '<div class="we-empty-actions"><button data-act="cfg-open">📁 设置壁纸目录…</button></div>'
        return
      }
      var html = '<div class="we-grid">'
      for (var i = 0; i < state.list.length; i++) {
        var e = state.list[i]
        var thumb = previewUrl(e.preview) || mediaUrl(e.file)
        var cur = state.current && state.current.id === e.id ? ' we-current' : ''
        var hint = e.kind === 'preview-only' && e.type === 'scene' ? '（3D场景，仅预览图）' : ''
        html += '<div class="we-card' + cur + '" data-i="' + i + '" title="' + esc(e.title + hint) + '">' +
          '<img loading="lazy" src="' + thumb + '" alt="">' +
          '<span class="we-kind">' + kindLabel(e.kind, e.type) + '</span>' +
          '<span class="we-ttl">' + esc(e.title) + '</span></div>'
      }
      html += '</div>'
      body.innerHTML = html
      renderStatus()
    }
    function renderStatus() {
      if (!panelEl) return
      var src = panelEl.querySelector('.we-src')
      if (src) {
        if (state.source === 'api') src.textContent = 'WE API'
        else if (state.source === 'scan') src.textContent = '目录扫描 ' + state.list.length
        else src.textContent = '—'
      }
      var follow = panelEl.querySelector('[data-follow]')
      if (follow) follow.checked = state.follow
      var blur = panelEl.querySelector('[data-blurfill]')
      if (blur) blur.checked = state.blurFill
      syncBrightness()
    }

    function togglePanel() {
      state.open = !state.open
      if (panelEl) {
        panelEl.classList.toggle('we-open', state.open)
        if (state.open) positionPanel()
      }
      if (state.open && !state.list.length && !state.loading) loadList(false)
    }
    function randomPick() {
      if (!state.list.length) return
      var pool = state.list.filter(function (e) { return e.kind !== 'preview-only' })
      if (!pool.length) pool = state.list
      var e = pool[Math.floor(Math.random() * pool.length)]
      applyWallpaper(e)
    }
    /** Manual light/dark flip — same mechanism the theme-follow toggle uses. */
    function toggleBrightness() {
      if (!themeService) { showMsg('主题服务不可用'); return }
      var pref = themeService.getTheme().preference
      var target = pref === 'dark' ? 'light' : 'dark'
      try {
        themeService.setTheme(target)
        syncBrightness()
      } catch (e) {
        showMsg('亮度切换失败')
      }
    }
    function syncBrightness() {
      if (!panelEl) return
      var btn = panelEl.querySelector('[data-act="brightness"]')
      if (!btn) return
      var pref = themeService ? themeService.getTheme().preference : 'system'
      btn.textContent = pref === 'dark' ? '亮度深' : '亮度浅'
      btn.classList.toggle('we-on', pref === 'dark')
    }

    function buildPanel() {
      panelEl = document.createElement('div')
      panelEl.id = 'dsh-we-panel'
      panelEl.innerHTML =
        '<div class="we-head"><b>一键换背景</b><span class="we-src">—</span>' +
        '<button class="we-close" data-act="close" title="关闭">✕</button></div>' +
        '<div class="we-toolbar">' +
        '<button data-act="refresh" title="重新扫描壁纸库">刷新</button>' +
        '<button data-act="random" title="随机换一张">随机</button>' +
        '<button data-act="clear" title="恢复 DSH 默认背景">关闭背景</button>' +
        '<button data-act="brightness" title="手动切换外观亮度（浅色/深色），与「明暗跟随」同一机制">亮度浅</button>' +
        '</div>' +
        '<div class="we-toolbar we-opts">' +
        '<label class="we-follow" title="根据壁纸亮度自动切换 DSH 深/浅色主题"><input type="checkbox" data-follow>明暗跟随</label>' +
        '<label class="we-follow" title="图片完整显示，两侧用模糊放大图填充（不裁切）"><input type="checkbox" data-blurfill>模糊填充</label>' +
        '</div>' +
        '<div class="we-msg"></div>' +
        '<div class="we-body"></div>' +
        '<div class="we-config">' +
        '<div class="we-cfg-title" data-act="cfg-open">⚙ 额外目录 / 高级设置</div>' +
        '</div>'
      panelEl.addEventListener('click', function (ev) {
        var act = ev.target.closest('[data-act]')
        if (act) {
          var a = act.getAttribute('data-act')
          if (a === 'close') togglePanel()
          else if (a === 'refresh') loadList(true)
          else if (a === 'random') randomPick()
          else if (a === 'clear') clearWallpaper()
          else if (a === 'brightness') toggleBrightness()
          else if (a === 'cfg-open') openDirPop()
        }
        var card = ev.target.closest('.we-card')
        if (card) {
          var i = parseInt(card.getAttribute('data-i'), 10)
          var entry = state.list[i]
          if (entry) applyWallpaper(entry)
        }
      })
      panelEl.addEventListener('change', function (ev) {
        var follow = ev.target.closest('[data-follow]')
        if (follow) {
          state.follow = follow.checked
          LS.setItem(KEY_FOLLOW, state.follow ? '1' : '0')
        }
        var blur = ev.target.closest('[data-blurfill]')
        if (blur) {
          state.blurFill = blur.checked
          LS.setItem('dsh-we:blurFill', state.blurFill ? '1' : '0')
          if (state.current) applyWallpaper(state.current, true)
          showMsg(state.blurFill ? '已开启模糊填充（图片完整显示）' : '已关闭模糊填充（全屏裁切）')
        }
      })
    }

    // ---- extra-dirs popup ----------------------------------------------------------
    function buildDirPop() {
      dirPopEl = document.createElement('div')
      dirPopEl.id = 'dsh-we-dirpop'
      dirPopEl.innerHTML =
        '<div class="we-pop-backdrop" data-pop-close></div>' +
        '<div class="we-pop">' +
        '<div class="we-pop-head"><span>额外目录</span><button class="we-pop-close" data-pop-close>✕</button></div>' +
        '<div class="we-addrow"><input placeholder="壁纸文件夹路径…（回车添加）" data-cfg-dir><button data-act="cfg-pick" title="系统文件夹选择对话框">📁 选择文件夹</button></div>' +
        '<div class="we-dirtable"></div>' +
        '<div class="we-msg"></div>' +
        '</div>'
      dirPopEl.addEventListener('click', function (ev) {
        if (ev.target.closest('[data-pop-close]')) { closeDirPop(); return }
        var act = ev.target.closest('[data-act]')
        if (act) {
          var a = act.getAttribute('data-act')
          if (a === 'cfg-add') addDirInput()
          else if (a === 'cfg-pick') pickDir()
        }
        var rm = ev.target.closest('[data-rm]')
        if (rm) {
          var idx = parseInt(rm.getAttribute('data-rm'), 10)
          var dirs2 = state.extraDirs.slice()
          dirs2.splice(idx, 1)
          state.extraDirs = dirs2
          saveConfig(dirs2)
          renderDirPop()
        }
      })
      dirPopEl.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Enter') return
        var input = dirPopEl.querySelector('[data-cfg-dir]')
        if (input && ev.target === input) {
          ev.preventDefault()
          addDirInput()
        }
      })
      document.body.appendChild(dirPopEl)
    }
    function openDirPop() {
      renderDirPop()
      dirPopEl.classList.add('we-open')
    }
    function closeDirPop() {
      dirPopEl.classList.remove('we-open')
    }
    function renderDirPop() {
      if (!dirPopEl) return
      var tbl = dirPopEl.querySelector('.we-dirtable')
      if (!tbl) return
      if (!state.extraDirs.length) {
        tbl.innerHTML = '<div class="we-dir-empty">（暂无目录，点上方「选择文件夹」添加）</div>'
        return
      }
      var rows = ''
      for (var i = 0; i < state.extraDirs.length; i++) {
        rows += '<div class="we-dirrow"><span class="we-dirpath" title="' + esc(state.extraDirs[i]) + '">' + esc(state.extraDirs[i]) + '</span><button data-rm="' + i + '" title="移除">✕</button></div>'
      }
      tbl.innerHTML = rows
    }

    // ---- floating toggle -----------------------------------------------------------
    function chipPos() {
      try {
        var p = JSON.parse(LS.getItem(CHIP_KEY) || 'null')
        if (p && typeof p.x === 'number' && typeof p.y === 'number') return p
      } catch (e) { /* ignore */ }
      return { x: Math.max(8, window.innerWidth - 54), y: Math.max(8, window.innerHeight - 54) }
    }
    function saveChipPos(x, y) {
      try { LS.setItem(CHIP_KEY, JSON.stringify({ x: x, y: y })) } catch (e) { /* ignore */ }
    }
    /** Anchor the panel above the chip (falls below when there is no room). */
    function positionPanel() {
      if (!panelEl || !chipEl) return
      var x = chipEl.offsetLeft + 40 - panelEl.offsetWidth
      var y = chipEl.offsetTop - 8 - panelEl.offsetHeight
      if (y < 8) y = chipEl.offsetTop + 40 + 8
      panelEl.style.left = Math.max(8, x) + 'px'
      panelEl.style.top = Math.max(8, y) + 'px'
      panelEl.style.right = 'auto'
      panelEl.style.bottom = 'auto'
    }
    function buildChip() {
      var chip = document.createElement('button')
      chip.id = 'dsh-we-chip'
      chip.type = 'button'
      chip.title = '一键换背景（Wallpaper Engine）'
      var img = document.createElement('img')
      img.src = '/we/icon'
      img.alt = ''
      img.style.cssText = 'width:22px;height:22px;object-fit:cover;border-radius:6px;pointer-events:none'
      chip.appendChild(img)
      var pos = chipPos()
      chip.style.left = pos.x + 'px'
      chip.style.top = pos.y + 'px'
      var drag = { on: false, moved: false, sx: 0, sy: 0, ox: 0, oy: 0 }
      chip.addEventListener('mousedown', function (e) {
        if (e.button !== 0) return
        drag.on = true
        drag.moved = false
        drag.sx = e.clientX
        drag.sy = e.clientY
        drag.ox = chip.offsetLeft
        drag.oy = chip.offsetTop
        e.preventDefault()
      })
      document.addEventListener('mousemove', function (e) {
        if (!drag.on) return
        var dx = e.clientX - drag.sx
        var dy = e.clientY - drag.sy
        if (!drag.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) drag.moved = true
        if (!drag.moved) return
        var x = Math.min(Math.max(0, drag.ox + dx), window.innerWidth - 40)
        var y = Math.min(Math.max(0, drag.oy + dy), window.innerHeight - 40)
        chip.style.left = x + 'px'
        chip.style.top = y + 'px'
        positionPanel()
      })
      document.addEventListener('mouseup', function () {
        if (!drag.on) return
        drag.on = false
        if (drag.moved) saveChipPos(chip.offsetLeft, chip.offsetTop)
      })
      chip.addEventListener('click', function (e) {
        if (e && e.stopPropagation) e.stopPropagation()
        if (drag.moved) { drag.moved = false; return }
        togglePanel()
      })
      return chip
    }
    function syncChip() {
      if (chipEl) chipEl.classList.toggle('we-on', !!state.current)
    }

    // ---- plugin entry --------------------------------------------------------------
    function restore() {
      try {
        var raw = LS.getItem(KEY_CURRENT)
        if (!raw) return
        var saved = JSON.parse(raw)
        if (!saved || (!saved.file && !saved.preview)) return
        var followBackup = state.follow
        state.follow = false
        applyWallpaper(saved, true)
        state.follow = followBackup
      } catch (e) { /* ignore */ }
    }

    function apply(ctx) {
      themeService = ctx.theme
      workspaceService = ctx.workspaces
      try { ctx.on('theme/change', function () { syncBrightness() }) } catch (e) { /* ignore */ }
      styleEl = document.createElement('style')
      styleEl.textContent = CSS
      document.head.appendChild(styleEl)
      ensureBg()
      restore()
      buildPanel()
      document.body.appendChild(panelEl)
      buildDirPop()
      chipEl = buildChip()
      document.body.appendChild(chipEl)
      console.log('[dsh-wallpaper-engine] ready')
      loadList(false)
      loadStatus()
      return function () {
        clearWallpaper()
        if (styleEl) styleEl.remove()
        if (panelEl) panelEl.remove()
        if (dirPopEl) dirPopEl.remove()
        if (chipEl) chipEl.remove()
        if (bgEl) bgEl.remove()
        styleEl = panelEl = dirPopEl = chipEl = bgEl = null
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
