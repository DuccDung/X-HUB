import { useEffect, useRef, useState, type FormEvent } from 'react'
import QRCode from 'qrcode'
import { api, ApiError } from './api'
import { MapView } from './Map'
import type { AdminLayout, TableLayout } from './shared'
import './admin.css'

type EditorView = 'editor' | 'preview'
type InspectorView = 'table' | 'qr'
type EditorAction = 'save' | 'publish' | 'logout'
type Selection = { tableId: string; chairId?: string }
type Notice = { text: string; error?: boolean; qr?: boolean }

function message(error: unknown) {
  return error instanceof Error ? error.message : 'Đã có lỗi. Bạn có thể thử lại.'
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function newId(kind: 'table' | 'chair') {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  const suffix = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${kind}-${suffix}`
}

function CoordinateField({
  label,
  value,
  min = 0,
  max = 100,
  onChange,
}: {
  label: string
  value: number
  min?: number
  max?: number
  onChange: (value: number) => void
}) {
  const [editing, setEditing] = useState<string | null>(null)

  function commit() {
    setEditing(null)
    if (editing !== null && editing.trim() !== '' && Number.isFinite(Number(editing))) {
      onChange(clamp(Number(editing), min, max))
    }
  }

  return (
    <label className="xc-admin__field">
      <span>{label}</span>
      <span className="xc-admin__coordinate">
        <input
          type="number"
          min={min}
          max={max}
          step="0.1"
          value={editing ?? Number(value.toFixed(1))}
          onChange={(event) => setEditing(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
          }}
        />
        <span aria-hidden="true">%</span>
      </span>
    </label>
  )
}

function Brand() {
  return (
    <a className="xc-admin__brand" href="/" aria-label="Trang chủ Xưởng Caffe">
      <img src="/art/brand.webp" alt="" width="42" height="42" />
      <span>Xưởng Caffe</span>
    </a>
  )
}

function Login({ onLogin }: { onLogin: (layout: AdminLayout) => void }) {
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError('')
    try {
      await api('/api/admin/login', {
        method: 'POST',
        body: JSON.stringify({ password }),
      })
      onLogin(await api<AdminLayout>('/api/admin/layout'))
    } catch (requestError) {
      setError(message(requestError))
    } finally {
      setPending(false)
    }
  }

  return (
    <main className="xc-admin xc-admin--center">
      <section className="xc-admin__login" aria-labelledby="admin-login-title">
        <Brand />
        <h1 id="admin-login-title">Quản trị sơ đồ</h1>
        <form onSubmit={submit}>
          <label className="xc-admin__field">
            <span>Mật khẩu quản trị</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          {error && <p className="xc-admin__notice xc-admin__notice--error" role="alert">{error}</p>}
          <button className="xc-admin__button xc-admin__button--primary" disabled={pending}>
            {pending ? 'Đang đăng nhập…' : 'Đăng nhập'}
          </button>
        </form>
      </section>
    </main>
  )
}

function QrPanel({ url, label, published }: { url?: string; label: string; published: boolean }) {
  const [image, setImage] = useState<string>()
  const [feedback, setFeedback] = useState('')

  useEffect(() => {
    if (!url) return
    let active = true
    void QRCode.toDataURL(url, {
      width: 420,
      margin: 4,
      errorCorrectionLevel: 'M',
    }).then((data) => {
      if (active) setImage(data)
    }, () => {
      if (active) setFeedback('Chưa tạo được ảnh QR. Bạn có thể mở liên kết bên dưới.')
    })
    return () => { active = false }
  }, [url])

  async function copyLink() {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setFeedback('Đã sao chép liên kết.')
    } catch {
      setFeedback('Chọn ô liên kết bên dưới để sao chép thủ công.')
    }
  }

  if (!url) return <p className="xc-admin__hint">Lưu nháp để tạo mã QR cho bàn này.</p>

  return (
    <div className="xc-admin__qr">
      <figure className="xc-admin__qr-print">
        <figcaption>Bàn {label}</figcaption>
        {image
          ? <img src={image} alt={`Mã QR bàn ${label}`} width="184" height="184" />
          : <div className="xc-admin__qr-placeholder" aria-label="Ảnh mã QR" />}
      </figure>
      {!published && <p className="xc-admin__hint">Khách có thể dùng mã sau khi công bố bàn này.</p>}
      <div className="xc-admin__qr-actions">
        <button type="button" className="xc-admin__button" onClick={() => window.print()} disabled={!image}>In mã</button>
        {image && <a className="xc-admin__button" href={image} download={`xuong-caffe-ban-${label}.png`}>Tải PNG</a>}
        <button type="button" className="xc-admin__button" onClick={() => void copyLink()}>Sao chép</button>
      </div>
      <label className="xc-admin__field">
        <span>Liên kết QR</span>
        <input value={url} readOnly onFocus={(event) => event.currentTarget.select()} />
      </label>
      {feedback && <p className="xc-admin__hint" role="status">{feedback}</p>}
    </div>
  )
}

function Editor({
  initial,
  onLogout,
}: {
  initial: AdminLayout
  onLogout: () => void
}) {
  const [layout, setLayout] = useState(initial)
  const [tables, setTables] = useState(initial.draft.tables)
  const [selection, setSelection] = useState<Selection | null>(() => {
    const first = initial.draft.tables[0]
    return first ? { tableId: first.id } : null
  })
  const [view, setView] = useState<EditorView>('editor')
  const [inspector, setInspector] = useState<InspectorView>('table')
  const [action, setAction] = useState<EditorAction | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const qrTab = useRef<HTMLButtonElement>(null)

  const selected = tables.find((table) => table.id === selection?.tableId)
  const chair = selected?.chairs.find((item) => item.id === selection?.chairId)
  const currentJson = JSON.stringify(tables)
  const draftJson = JSON.stringify(layout.draft.tables)
  const dirty = currentJson !== draftJson
  const unpublished = draftJson !== JSON.stringify(layout.published.tables)
  const valid = tables.every((table) => table.label.trim().length > 0)
    && new Set(tables.map((table) => table.label.trim().toLowerCase())).size === tables.length
  const publishedLabel = layout.published.tables.find((table) => table.id === selected?.id)?.label
  const qrToken = selected && layout.qrs[selected.id]
  const qrUrl = qrToken ? new URL(`/?table=${encodeURIComponent(qrToken)}`, window.location.origin).href : undefined

  useEffect(() => {
    if (!dirty) return
    function protectChanges(event: BeforeUnloadEvent) {
      event.preventDefault()
    }
    window.addEventListener('beforeunload', protectChanges)
    return () => window.removeEventListener('beforeunload', protectChanges)
  }, [dirty])

  function updateTable(id: string, change: (table: TableLayout) => TableLayout) {
    setTables((current) => current.map((table) => table.id === id ? change(table) : table))
  }

  function selectTable(id: string) {
    setSelection({ tableId: id })
  }

  function selectChair(tableId: string, chairId: string) {
    setSelection({ tableId, chairId })
    setInspector('table')
  }

  function moveTable(id: string, x: number, y: number) {
    updateTable(id, (table) => ({ ...table, x, y }))
  }

  function moveChair(tableId: string, chairId: string, x: number, y: number) {
    updateTable(tableId, (table) => ({
      ...table,
      chairs: table.chairs.map((item) => item.id === chairId ? { ...item, x, y } : item),
    }))
  }

  function addTable() {
    const usedLabels = new Set(tables.map((table) => table.label.trim()))
    const label = Array.from({ length: 81 }, (_, index) => String(index + 1).padStart(2, '0'))
      .find((number) => !usedLabels.has(number))!
    const id = newId('table')
    const candidates = [55, 45, 65, 35, 75, 25].flatMap((y) => [50, 38, 62, 29, 71].map((x) => ({ x, y })))
    const placement = candidates.find(({ x, y }) => tables.every((table) =>
      Math.abs(table.x - x) >= 10 || Math.abs(table.y - y) >= 13,
    )) ?? { x: 50, y: 50 }
    setTables((current) => [...current, {
      id,
      label,
      shape: 'round',
      ...placement,
      rotation: 0,
      chairs: [
        { id: 'top', x: 0, y: -4.8 },
        { id: 'bottom', x: 0, y: 4.8 },
      ],
    }])
    selectTable(id)
    setInspector('table')
    setView('editor')
  }

  function removeTable(table: TableLayout) {
    const label = table.label.trim() || 'đang chọn'
    const wasPublished = layout.published.tables.some((item) => item.id === table.id)
    const hint = wasPublished ? ' Mã QR của bàn sẽ hết hiệu lực khi công bố sơ đồ.' : ''
    if (!window.confirm(`Xóa bàn ${label} và toàn bộ ghế của bàn khỏi bản nháp?${hint}`)) return

    const index = tables.findIndex((item) => item.id === table.id)
    const remaining = tables.filter((item) => item.id !== table.id)
    setTables(remaining)
    const next = remaining[index] ?? remaining.at(-1)
    setSelection(next ? { tableId: next.id } : null)
    setNotice(null)
  }

  function addChair(table: TableLayout) {
    const id = newId('chair')
    const offsets = [
      { x: 0, y: -4.8 },
      { x: 0, y: 4.8 },
      { x: -7.5, y: 0 },
      { x: 7.5, y: 0 },
      { x: 4.6, y: -4.8 },
      { x: -4.6, y: -4.8 },
      { x: 4.6, y: 4.8 },
      { x: -4.6, y: 4.8 },
    ]
    const offset = offsets.find(({ x, y }) => table.chairs.every((item) =>
      Math.abs(item.x - x) >= 4 || Math.abs(item.y - y) >= 2.5,
    )) ?? { x: 7.5, y: 0 }
    updateTable(table.id, (item) => ({ ...item, chairs: [...item.chairs, { id, ...offset }] }))
    selectChair(table.id, id)
  }

  function removeChair(table: TableLayout, chairId: string) {
    updateTable(table.id, (item) => ({ ...item, chairs: item.chairs.filter((seat) => seat.id !== chairId) }))
    selectTable(table.id)
  }

  async function persist(kind: 'save' | 'publish') {
    setAction(kind)
    setNotice(null)
    try {
      const response = kind === 'save'
        ? await api<AdminLayout>('/api/admin/layout', {
          method: 'PUT',
          body: JSON.stringify({ tables, version: layout.draft.version }),
        })
        : await api<AdminLayout>('/api/admin/publish', {
          method: 'POST',
          body: JSON.stringify({ version: layout.draft.version }),
        })
      setLayout(response)
      setTables(response.draft.tables)
      setNotice({ text: kind === 'save' ? 'Đã lưu bản nháp.' : 'Đã công bố sơ đồ cho khách.', qr: true })
    } catch (requestError) {
      if (requestError instanceof ApiError && requestError.status === 401) {
        setNotice({ text: 'Phiên quản trị đã hết hạn. Tải lại trang để đăng nhập lại.', error: true })
      } else {
        setNotice({ text: message(requestError), error: true })
      }
    } finally {
      setAction(null)
    }
  }

  async function logout() {
    if (dirty && !window.confirm('Thoát phiên quản trị và bỏ các thay đổi chưa lưu?')) return
    setAction('logout')
    setNotice(null)
    try {
      await api('/api/admin/logout', { method: 'POST' })
      onLogout()
    } catch (requestError) {
      setNotice({ text: message(requestError), error: true })
    } finally {
      setAction(null)
    }
  }

  const status = !valid ? 'Số bàn phải có nội dung và khác nhau.'
    : dirty ? 'Thay đổi chưa lưu'
    : unpublished ? 'Bản nháp đã lưu'
    : 'Đang hiển thị cho khách'

  return (
    <main className="xc-admin">
      <header className="xc-admin__header">
        <Brand />
        <button type="button" className="xc-admin__button xc-admin__button--quiet" onClick={() => void logout()} disabled={action !== null}>
          {action === 'logout' ? 'Đang thoát…' : 'Đăng xuất'}
        </button>
      </header>
      <div className="xc-admin__workspace">
        <div className="xc-admin__workspace-header">
          <div>
            <h1>Bố trí bàn ghế</h1>
            <p className={`xc-admin__status${dirty ? ' xc-admin__status--dirty' : ''}`}>{status}</p>
          </div>
          <div className="xc-admin__save-actions">
            <button type="button" className="xc-admin__button" disabled={!dirty || !valid || action !== null} onClick={() => void persist('save')}>
              {action === 'save' ? 'Đang lưu…' : 'Lưu nháp'}
            </button>
            <button type="button" className="xc-admin__button xc-admin__button--primary" disabled={dirty || !unpublished || action !== null} onClick={() => void persist('publish')}>
              {action === 'publish' ? 'Đang công bố…' : 'Công bố'}
            </button>
          </div>
        </div>
        {notice && (!dirty || notice.error) && (
          <div className={`xc-admin__notice${notice.error ? ' xc-admin__notice--error' : ''}`}>
            <span role={notice.error ? 'alert' : 'status'}>{notice.text}</span>
            {notice.qr && qrUrl && (
              <button className="xc-admin__button" type="button" onClick={() => {
                setInspector('qr')
                qrTab.current?.focus()
              }}>Xem mã QR</button>
            )}
          </div>
        )}
        <div className="xc-admin__grid">
          <section className="xc-admin__stage" aria-label="Trình chỉnh sơ đồ">
            <div className="xc-admin__stage-toolbar">
              <div className="xc-admin__switch" role="group" aria-label="Chế độ hiển thị">
                <button type="button" aria-pressed={view === 'editor'} onClick={() => setView('editor')}>Chỉnh sơ đồ</button>
                <button type="button" aria-pressed={view === 'preview'} onClick={() => setView('preview')}>Xem trước</button>
              </div>
              <span className="xc-admin__count">{tables.length} bàn</span>
            </div>
            <div className={`xc-admin__canvas${view === 'preview' ? ' xc-admin__canvas--preview' : ''}`}>
              <div className="xc-admin__map">
                <MapView
                  tables={tables}
                  mode={view === 'editor' ? 'editor' : 'guest'}
                  currentTableId={view === 'preview' ? selected?.id : null}
                  selectedTableId={view === 'editor' ? selected?.id : null}
                  selectedChairId={view === 'editor' ? chair?.id : null}
                  onTableClick={view === 'editor' ? selectTable : undefined}
                  onChairClick={view === 'editor' ? selectChair : undefined}
                  onTableDrag={view === 'editor' && !action ? moveTable : undefined}
                  onChairDrag={view === 'editor' && !action ? moveChair : undefined}
                />
              </div>
            </div>
            <p className="xc-admin__stage-hint">
              {view === 'editor' ? 'Kéo bàn để dời cả cụm, kéo ghế để chỉnh riêng.' : 'Xem sơ đồ trên điện thoại từ vị trí bàn đã chọn.'}
            </p>
          </section>
          <aside className="xc-admin__inspector" aria-label="Thiết lập bàn ghế">
            <div className="xc-admin__inspector-tabs" role="group" aria-label="Thông tin bàn">
              <button type="button" aria-pressed={inspector === 'table'} onClick={() => setInspector('table')}>Bàn ghế</button>
              <button ref={qrTab} type="button" aria-pressed={inspector === 'qr'} onClick={() => setInspector('qr')}>Mã QR</button>
            </div>
            <fieldset className="xc-admin__inspector-body" disabled={action !== null}>
              <div className="xc-admin__table-picker">
                <label className="xc-admin__field">
                  <span>Chọn bàn</span>
                  <select value={selected?.id ?? ''} disabled={!tables.length} onChange={(event) => selectTable(event.target.value)}>
                    {tables.length === 0 && <option value="">Chưa có bàn</option>}
                    {tables.map((table) => <option key={table.id} value={table.id}>Bàn {table.label}</option>)}
                  </select>
                </label>
                <div className="xc-admin__table-actions">
                  <button type="button" className="xc-admin__button" onClick={addTable} disabled={tables.length >= 80}>Thêm bàn</button>
                  {selected && <button type="button" className="xc-admin__button xc-admin__button--delete-table"
                    onClick={() => removeTable(selected)}>Xóa bàn</button>}
                </div>
              </div>
              {selected && inspector === 'table' && (
                <>
                  <div className="xc-admin__input-row">
                    <label className="xc-admin__field">
                      <span>Số bàn</span>
                      <input
                        value={selected.label}
                        maxLength={12}
                        onChange={(event) => {
                          const label = event.target.value
                          updateTable(selected.id, (table) => ({ ...table, label }))
                        }}
                      />
                    </label>
                    <label className="xc-admin__field">
                      <span>Kiểu bàn</span>
                      <select value={selected.shape} onChange={(event) => {
                        const shape = event.target.value === 'square' ? 'square' : 'round'
                        updateTable(selected.id, (table) => ({ ...table, shape }))
                      }}>
                        <option value="round">Bàn tròn</option>
                        <option value="square">Bàn vuông</option>
                      </select>
                    </label>
                  </div>
                  <div className="xc-admin__input-row" key={selected.id}>
                    <CoordinateField label="Vị trí ngang" value={selected.x} onChange={(x) => moveTable(selected.id, x, selected.y)} />
                    <CoordinateField label="Vị trí dọc" value={selected.y} onChange={(y) => moveTable(selected.id, selected.x, y)} />
                  </div>
                  <button className="xc-admin__button xc-admin__button--rotation" type="button" onClick={() => updateTable(selected.id, (table) => ({
                    ...table,
                    rotation: (table.rotation + 90) % 360,
                  }))}>
                    <span>Xoay bàn 90°</span>
                    <span className="xc-admin__angle">{selected.rotation}°</span>
                  </button>
                  <section className="xc-admin__chair-settings" aria-label="Vị trí ghế">
                    <div className="xc-admin__table-controls">
                      <label className="xc-admin__field">
                        <span>Ghế của bàn</span>
                        <select value={chair?.id ?? ''} onChange={(event) => {
                          const id = event.target.value
                          if (id) selectChair(selected.id, id)
                          else selectTable(selected.id)
                        }}>
                          <option value="">{selected.chairs.length ? 'Chọn ghế' : 'Chưa có ghế'}</option>
                          {selected.chairs.map((seat, index) => <option key={seat.id} value={seat.id}>Ghế {index + 1}</option>)}
                        </select>
                      </label>
                      <button type="button" className="xc-admin__button" onClick={() => addChair(selected)} disabled={selected.chairs.length >= 12}>Thêm ghế</button>
                    </div>
                    {chair && (
                      <div className="xc-admin__chair-coordinate" key={chair.id}>
                        <div className="xc-admin__input-row">
                          <CoordinateField label="Lệch ngang" value={chair.x} min={-100} onChange={(x) => moveChair(selected.id, chair.id, x, chair.y)} />
                          <CoordinateField label="Lệch dọc" value={chair.y} min={-100} onChange={(y) => moveChair(selected.id, chair.id, chair.x, y)} />
                        </div>
                        <button className="xc-admin__button xc-admin__button--danger" type="button" onClick={() => removeChair(selected, chair.id)}>Bỏ ghế này</button>
                      </div>
                    )}
                  </section>
                </>
              )}
              {selected && inspector === 'qr' && (
                <QrPanel
                  key={`${selected.id}-${qrUrl ?? 'draft'}`}
                  label={publishedLabel ?? selected.label}
                  published={publishedLabel !== undefined}
                  url={qrUrl}
                />
              )}
            </fieldset>
          </aside>
        </div>
      </div>
    </main>
  )
}

export function Admin() {
  const [layout, setLayout] = useState<AdminLayout | null>(null)
  const [lookup, setLookup] = useState(0)
  const [waiting, setWaiting] = useState(true)
  const [loadError, setLoadError] = useState('')

  useEffect(() => {
    let active = true
    void api<AdminLayout>('/api/admin/layout').then((current) => {
      if (active) setLayout(current)
    }, (requestError: unknown) => {
      if (active && !(requestError instanceof ApiError && requestError.status === 401)) {
        setLoadError(message(requestError))
      }
    }).finally(() => {
      if (active) setWaiting(false)
    })
    return () => { active = false }
  }, [lookup])

  if (layout) return <Editor initial={layout} onLogout={() => setLayout(null)} />
  if (!waiting && !loadError) return <Login onLogin={setLayout} />

  return (
    <main className="xc-admin xc-admin--center">
      <section className="xc-admin__login">
        <Brand />
        <h1>Quản trị sơ đồ</h1>
        {waiting ? <p role="status">Đang tải…</p> : (
          <>
            <p className="xc-admin__notice xc-admin__notice--error" role="alert">{loadError}</p>
            <button className="xc-admin__button" type="button" onClick={() => {
              setLoadError('')
              setWaiting(true)
              setLookup((current) => current + 1)
            }}>Thử lại</button>
          </>
        )}
      </section>
    </main>
  )
}
