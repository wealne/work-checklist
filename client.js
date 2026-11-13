window.__ModuleLoader__.load({
  id: 'work-checklist',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PANEL_ID = 'work-checklist';
    const CONFIG_ROUTE = '/work-checklist/config';

    /** Sidebar rail glyph: a small grid, drawn with currentColor. */
    function SheetIcon({ size }) {
      const edge = typeof size === 'number' ? size : 16;
      return h(
        'svg',
        {
          width: edge,
          height: edge,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': true,
          focusable: false,
        },
        h('rect', { x: 1.75, y: 2.75, width: 12.5, height: 10.5, rx: 1.6, stroke: 'currentColor', strokeWidth: 1.3 }),
        h('path', { d: 'M1.75 6.1h12.5M6.2 6.1v7.15M1.75 9.6h12.5', stroke: 'currentColor', strokeWidth: 1.1, opacity: 0.75 }),
      );
    }

    /**
     * Re-render on locale switches. The sidebar label is a thunk and re-reads
     * itself, but the toolbar text is rendered once per mount.
     */
    function useLocaleTick() {
      const [, force] = React.useState(0);
      React.useEffect(() => {
        let dispose = null;
        try {
          const service = ctxRef && ctxRef.get('locale');
          if (service && typeof service.subscribe === 'function') {
            dispose = service.subscribe(() => force((n) => n + 1));
          }
        } catch {
          /* no locale service: the document language is enough */
        }
        return () => {
          if (typeof dispose === 'function') dispose();
        };
      }, []);
    }

    /** The `main` slot body: a seat the persistent overlay measures and covers. */
    function SheetSeat() {
      return h('div', {
        'data-work-checklist-seat': true,
        style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' },
      });
    }

    /**
     * The live sheet. It lives in `shell.overlay`, which the frame never
     * unmounts, and follows the seat the `main` slot reserves.
     *
     * Moving an iframe in the DOM reloads it, hiding it does not — so switching
     * panels only toggles `display`, and the DingTalk session (auth, scroll,
     * open editor) survives every trip to another conversation.
     */
    function SheetOverlay() {
      const [box, setBox] = React.useState(null);
      const [state, setState] = React.useState({ phase: 'loading', url: '', error: '' });
      const [attempt, setAttempt] = React.useState(0);
      const [showSettings, setShowSettings] = React.useState(false);
      const frameRef = React.useRef(null);
      useLocaleTick();

      // Geometry loop. The seat only exists while this panel is selected, so its
      // presence doubles as the "am I visible" signal — no layout service needed.
      React.useEffect(() => {
        let raf = 0;
        let last = '';
        let frame = 0;
        const step = () => {
          raf = requestAnimationFrame(step);
          if (frame++ % 4 !== 0) return;
          const seat = document.querySelector('[data-work-checklist-seat]');
          const layer = document.querySelector('[data-shell-overlay]');
          if (!seat || !layer) {
            if (last !== '') {
              last = '';
              setBox(null);
            }
            return;
          }
          const s = seat.getBoundingClientRect();
          const l = layer.getBoundingClientRect();
          const next = {
            left: Math.round(s.left - l.left),
            top: Math.round(s.top - l.top),
            width: Math.round(s.width),
            height: Math.round(s.height),
          };
          const key = next.left + ',' + next.top + ',' + next.width + ',' + next.height;
          if (key === last) return;
          last = key;
          setBox(next);
        };
        raf = requestAnimationFrame(step);
        return () => cancelAnimationFrame(raf);
      }, []);

      React.useEffect(() => {
        let cancelled = false;
        setState((prev) => (prev.phase === 'ready' ? prev : { phase: 'loading', url: '', error: '' }));
        fetch(CONFIG_ROUTE, { headers: { accept: 'application/json' } })
          .then(async (response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json();
          })
          .then((payload) => {
            if (cancelled) return;
            if (payload && payload.configured === false) {
              setState({ phase: 'unset', url: '', error: '' });
              // First run: unfold the form so the field is right there.
              setShowSettings(true);
            } else if (payload && typeof payload.url === 'string' && payload.url) {
              setState({ phase: 'ready', url: payload.url, error: '' });
            } else {
              setState({ phase: 'error', url: '', error: (payload && payload.error) || 'no embed url' });
            }
          })
          .catch((cause) => {
            if (!cancelled) setState({ phase: 'error', url: '', error: String(cause && cause.message ? cause.message : cause) });
          });
        return () => {
          cancelled = true;
        };
      }, [attempt]);

      const reload = () => setAttempt((n) => n + 1);

      const bar = h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            height: 36,
            flex: '0 0 auto',
            padding: '0 10px',
            borderBottom: '1px solid var(--dsw-alias-border-l2)',
            background: 'var(--dsw-alias-bg-base)',
            color: 'var(--dsw-alias-label-secondary)',
            fontSize: 12,
          },
        },
        h('span', { style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, label('title')),
        h('span', { style: { flex: 1 } }),
        h(
          'button',
          {
            type: 'button',
            onClick: () => setShowSettings((open) => !open),
            style: {
              height: 24,
              padding: '0 10px',
              borderRadius: 'var(--dsw-radius-md, 6px)',
              border: '1px solid var(--dsw-alias-border-l3)',
              background: showSettings ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
              color: 'inherit',
              cursor: 'pointer',
              font: 'inherit',
            },
          },
          label('settings'),
        ),
        h(
          'button',
          {
            type: 'button',
            onClick: reload,
            style: {
              height: 24,
              padding: '0 10px',
              borderRadius: 'var(--dsw-radius-md, 6px)',
              border: '1px solid var(--dsw-alias-border-l3)',
              background: 'transparent',
              color: 'inherit',
              cursor: 'pointer',
              font: 'inherit',
            },
          },
          label('reload'),
        ),
        h(
          'button',
          {
            type: 'button',
            onClick: () => {
              const layout = ctxRef && ctxRef.get('layout');
              if (layout) layout.selectPanel(null);
            },
            style: {
              height: 24,
              padding: '0 10px',
              borderRadius: 'var(--dsw-radius-md, 6px)',
              border: '1px solid var(--dsw-alias-border-l3)',
              background: 'transparent',
              color: 'inherit',
              cursor: 'pointer',
              font: 'inherit',
            },
          },
          label('back'),
        ),
      );

      let body;
      if (state.phase === 'ready') {
        body = h('iframe', {
          ref: frameRef,
          key: state.url + attempt,
          src: state.url,
          title: label('title'),
          style: { flex: 1, minHeight: 0, width: '100%', border: '0', background: '#fff' },
          allow: 'clipboard-read; clipboard-write; fullscreen',
        });
      } else if (state.phase === 'unset') {
        body = h(
          'div',
          { style: { flex: 1, display: 'grid', placeItems: 'center', padding: 24, color: 'var(--dsw-alias-label-secondary)' } },
          h(
            'div',
            { style: { maxWidth: 520, textAlign: 'center', lineHeight: 1.7 } },
            h('div', { style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, label('noUrl')),
            h('div', { style: { opacity: 0.75, marginTop: 6, fontSize: 12 } }, label('noUrlHint')),
            h(
              'button',
              {
                type: 'button',
                onClick: () => setShowSettings(true),
                style: {
                  marginTop: 14,
                  height: 28,
                  padding: '0 14px',
                  borderRadius: 'var(--dsw-radius-md, 6px)',
                  border: '1px solid var(--dsw-alias-border-l3)',
                  background: 'var(--dsw-alias-interactive-bg-hover)',
                  color: 'var(--dsw-alias-label-primary)',
                  cursor: 'pointer',
                  font: 'inherit',
                },
              },
              label('settings'),
            ),
          ),
        );
      } else if (state.phase === 'error') {
        body = h(
          'div',
          { style: { flex: 1, display: 'grid', placeItems: 'center', padding: 24, color: 'var(--dsw-alias-label-secondary)' } },
          h('div', { style: { maxWidth: 520, textAlign: 'center', lineHeight: 1.6 } }, label('failed'), h('div', { style: { opacity: 0.7, marginTop: 8, fontSize: 12 } }, state.error)),
        );
      } else {
        body = h(
          'div',
          { style: { flex: 1, display: 'grid', placeItems: 'center', color: 'var(--dsw-alias-label-tertiary)' } },
          label('loading'),
        );
      }

      // Reachable from this toolbar so the address is one click away, instead of
      // buried under the README on the plugin page.
      const settings = h(
        'div',
        {
          style: {
            flex: '0 0 auto',
            maxHeight: '60%',
            overflow: 'auto',
            borderBottom: '1px solid var(--dsw-alias-border-l2)',
            background: 'var(--dsw-alias-bg-layer-3)',
          },
        },
        h(ConfigView, { view: 'page' }),
      );

      return h(
        'div',
        {
          style: {
            position: 'absolute',
            left: box ? box.left : 0,
            top: box ? box.top : 0,
            width: box ? box.width : 0,
            height: box ? box.height : 0,
            display: box ? 'flex' : 'none',
            flexDirection: 'column',
            minHeight: 0,
            background: 'var(--dsw-alias-bg-base)',
          },
        },
        showSettings ? settings : null,
        bar,
        body,
      );
    }

    /**
     * Plugin-page configuration (the `plugins.row.config` slot). DSH never
     * renders a form from `Config` on its own — the bundle has to draw the
     * fields and hand the changed paths to the host form controller, which
     * validates them against `Config` and rewrites the profile patch.
     */
    /**
     * The bundle detail page renders `plugins.bundle.config` with only
     * `{ view }`; the row detail page is the one that supplies `form`. Falling
     * back to the shared `configForms` service keeps the URL editable from the
     * bundle page too, and its snapshot store drives the re-render.
     */
    function ownForm() {
      const ctx = ctxRef;
      const service = ctx && typeof ctx.get === 'function' ? ctx.get('configForms') : undefined;
      if (!service || typeof service.get !== 'function') return null;
      try {
        const controller = service.get(PANEL_ID);
        return controller || null;
      } catch {
        return null;
      }
    }

    function ConfigView(props) {
      useLocaleTick();

      if (props.view === 'summary') return label('summary');

      const injected = props.form ? props.form.state : null;
      const controller = props.form ? null : ownForm();
      const snapState = React.useState(null);
      const ownSnap = snapState[0];
      const setSnap = snapState[1];
      const snap = injected || ownSnap;

      React.useEffect(() => {
        if (!controller || typeof controller.subscribe !== 'function') return undefined;
        setSnap(controller.getSnapshot());
        const off = controller.subscribe(() => setSnap(controller.getSnapshot()));
        if (typeof off === 'function') return off;
        return undefined;
      }, [controller]);

      const form = props.form || (controller ? { state: snap, mutate: (ops, revision) => controller.mutate(ops, revision) } : null);
      const field = React.useState(null);
      const draft = field[0];
      const setDraft = field[1];
      const feedback = React.useState(null);
      const result = feedback[0];
      const setResult = feedback[1];
      const busyState = React.useState(false);
      const busy = busyState[0];
      const setBusy = busyState[1];

      if (!snap) {
        return h(
          'p',
          { style: { margin: 0, padding: '10px 12px', fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary)' } },
          label('unavailable'),
        );
      }

      const shipped = Object.assign({}, snap.base || {}, snap.value || {});
      const effective = draft === null ? shipped : draft;
      const writable = !!snap.writable && snap.status === 'ready';

      const changedOps = () => {
        const ops = [];
        if (JSON.stringify(effective.url) !== JSON.stringify(shipped.url)) {
          ops.push({ op: 'set', path: ['url'], value: effective.url });
        }
        if (JSON.stringify(effective.port) !== JSON.stringify(shipped.port)) {
          ops.push({ op: 'set', path: ['port'], value: Number(effective.port) });
        }
        return ops;
      };

      const edit = (key, value) => {
        setResult(null);
        setDraft(Object.assign({}, effective, { [key]: value }));
      };

      const save = () => {
        const ops = changedOps();
        if (ops.length === 0) {
          setDraft(null);
          return;
        }
        setBusy(true);
        setResult(null);
        Promise.resolve(form.mutate(ops, snap.revision))
          .then((accepted) => {
            setBusy(false);
            if (accepted === false) {
              setResult({ ok: false, message: label('saveFailed') });
              return;
            }
            setDraft(null);
            setResult({ ok: true });
          })
          .catch((cause) => {
            setBusy(false);
            setResult({ ok: false, message: String((cause && cause.message) || cause) });
          });
      };

      const rowStyle = { display: 'flex', flexDirection: 'column', gap: 4 };
      const labelStyle = { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' };
      const hintStyle = { fontSize: 11, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' };
      const inputStyle = {
        boxSizing: 'border-box',
        width: '100%',
        height: 28,
        padding: '0 8px',
        borderRadius: 'var(--dsw-radius-md, 6px)',
        border: '1px solid var(--dsw-alias-border-l3)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: 12,
        opacity: writable ? 1 : 0.6,
      };

      const dirty = changedOps().length > 0;
      let status = null;
      if (busy) status = label('saving');
      else if (result && result.ok) status = label('saved');
      else if (result && result.ok === false) status = result.message || label('saveFailed');
      else if (!writable) status = label('readOnly');
      else if (dirty) status = label('dirty');

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 12, padding: '12px 12px 4px', maxWidth: 720 } },
        h(
          'div',
          { style: rowStyle },
          h('label', { style: labelStyle, htmlFor: 'work-checklist-url' }, label('urlLabel')),
          h('input', {
            id: 'work-checklist-url',
            type: 'text',
            value: effective.url == null ? '' : String(effective.url),
            spellCheck: false,
            autoComplete: 'off',
            disabled: busy || !writable,
            style: inputStyle,
            onChange: (event) => edit('url', event.target.value),
          }),
          h('div', { style: hintStyle }, label('urlHint')),
        ),
        h(
          'div',
          { style: Object.assign({}, rowStyle, { maxWidth: 200 }) },
          h('label', { style: labelStyle, htmlFor: 'work-checklist-port' }, label('portLabel')),
          h('input', {
            id: 'work-checklist-port',
            type: 'number',
            min: 0,
            value: effective.port == null ? '' : String(effective.port),
            disabled: busy || !writable,
            style: inputStyle,
            onChange: (event) => edit('port', event.target.value),
          }),
          h('div', { style: hintStyle }, label('portHint')),
        ),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 8 } },
          h(
            'button',
            {
              type: 'button',
              disabled: busy || !dirty || !writable,
              onClick: save,
              style: {
                height: 26,
                padding: '0 12px',
                borderRadius: 'var(--dsw-radius-md, 6px)',
                border: '1px solid var(--dsw-alias-border-l3)',
                background: 'var(--dsw-alias-interactive-bg-hover)',
                color: 'var(--dsw-alias-label-primary)',
                cursor: busy || !dirty || !writable ? 'default' : 'pointer',
                font: 'inherit',
                fontSize: 12,
                opacity: busy || !dirty || !writable ? 0.6 : 1,
              },
            },
            busy ? label('saving') : label('save'),
          ),
          h(
            'button',
            {
              type: 'button',
              disabled: busy || !dirty,
              onClick: () => {
                setDraft(null);
                setResult(null);
              },
              style: {
                height: 26,
                padding: '0 12px',
                borderRadius: 'var(--dsw-radius-md, 6px)',
                border: '1px solid var(--dsw-alias-border-l3)',
                background: 'transparent',
                color: 'var(--dsw-alias-label-secondary)',
                cursor: busy || !dirty ? 'default' : 'pointer',
                font: 'inherit',
                fontSize: 12,
                opacity: busy || !dirty ? 0.6 : 1,
              },
            },
            label('discard'),
          ),
          status
            ? h('span', { role: 'status', style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } }, status)
            : null,
        ),
      );
    }

    /** Resolved through the client locale service; English fallback. */
    const messages = {
      zh: {
        title: '工作清单',
        reload: '重新加载',
        back: '返回会话',
        settings: '设置',
        settingsTitle: '表格地址与端口',
        loading: '正在加载清单…',
        failed: '无法加载工作清单',
        noUrl: '还没有设置表格地址',
        noUrlHint: '点击上方「设置」，粘贴你的钉钉文档链接即可开始。',
        summary: '钉钉表格的地址与本地代理端口。',
        urlLabel: '表格地址',
        urlHint: '钉钉文档链接。粘贴浏览器地址栏里的 /i/nodes/… 或 /iframe/notable?… 都行。',
        portLabel: '本地端口',
        portHint: '0 表示每次启动自动挑一个空闲端口。',
        save: '保存',
        discard: '放弃修改',
        saved: '已保存，面板重新打开后生效。',
        saving: '正在保存…',
        saveFailed: '保存失败',
        readOnly: '当前只读，无法修改。',
        unavailable: '配置尚未就绪，稍后再试。',
        dirty: '有未保存的修改。',
      },
      en: {
        title: 'Work Checklist',
        reload: 'Reload',
        back: 'Back to chat',
        settings: 'Settings',
        settingsTitle: 'Address and port',
        loading: 'Loading the checklist…',
        failed: 'Could not load the checklist',
        noUrl: 'No table address yet',
        noUrlHint: 'Open Settings above and paste your DingTalk document link to start.',
        summary: 'The table address and the local proxy port.',
        urlLabel: 'Table address',
        urlHint: 'A DingTalk document link: /i/nodes/… or /iframe/notable?… both work.',
        portLabel: 'Local port',
        portHint: '0 picks a free port on every start.',
        save: 'Save',
        discard: 'Discard',
        saved: 'Saved — reopen the panel to apply.',
        saving: 'Saving…',
        saveFailed: 'Could not save',
        readOnly: 'Read only right now.',
        unavailable: 'Configuration is not ready yet.',
        dirty: 'Unsaved changes.',
      },
    };

    let ctxRef = null;

    /**
     * Pick the message table. Candidate ids are tried in order and the first one
     * that actually has a dictionary wins, so an unexpected id from the locale
     * service can never silently downgrade the UI to English.
     */
    function table() {
      const candidates = [];
      try {
        const service = ctxRef && ctxRef.get('locale');
        const snapshot = service && service.getSnapshot && service.getSnapshot();
        if (snapshot && typeof snapshot === 'object') {
          for (const id of [snapshot.active, snapshot.locale, snapshot.language]) {
            if (typeof id === 'string' && id) candidates.push(id);
          }
        }
      } catch {
        /* fall through to the document language */
      }
      try {
        const lang = document.documentElement.lang;
        if (typeof lang === 'string' && lang) candidates.push(lang);
      } catch {
        /* fall through to the browser language */
      }
      try {
        if (typeof navigator !== 'undefined' && navigator.language) candidates.push(navigator.language);
      } catch {
        /* fall through to the default */
      }
      for (const id of candidates) {
        const found = messages[id] || messages[id.split('-')[0]];
        if (found) return found;
      }
      return messages.en;
    }

    function label(key) {
      const found = table();
      return found[key] || messages.en[key] || key;
    }

    return {
      name: PANEL_ID,
      inject: ['slots'],
      apply(ctx) {
        ctxRef = ctx;
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID }, SheetSeat),
        );
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: PANEL_ID }, SheetOverlay),
        );
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => label('title') },
            SheetIcon,
          ),
        );
        // The plugin page only shows a configuration section for a bundle that
        // registered `plugins.bundle.config`, and a row's Configure button only
        // opens the form when the row registered `plugins.row.config` under
        // "<bundle>#<rowId>". Registering both keys keeps either entry point
        // working; the component is the same.
        for (const key of [PANEL_ID, `${PANEL_ID}#${PANEL_ID}`]) {
          ctx.slots.inject('plugins.bundle.config', () =>
            ctx.slots.register({ name: 'plugins.bundle.config', key }, ConfigView),
          );
          ctx.slots.inject('plugins.row.config', () =>
            ctx.slots.register({ name: 'plugins.row.config', key }, ConfigView),
          );
        }
      },
    };
  },
});
