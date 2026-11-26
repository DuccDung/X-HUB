import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent, TouchEvent } from 'react';
import { api, ApiError } from './api';
import { compressJournalPhoto } from './photoCompress';
import type { CompressedPhotoDraft } from './photoCompress';
import { journalMaxNoteLength, journalMaxPhotosPerEntry } from './shared';
import type { FloorId, JournalEntry, JournalPhoto, JournalState } from './shared';
import './journal-panel.css';

type FilterTab = 'all' | 'favorite';
type ViewMode = 'album' | 'grid';
type ViewerState = { entryId: string; photoId: string };

interface CurrentSeat {
  id: string;
  label: string;
  floor: FloorId;
}

const timeFormat = new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit' });
const shortDateFormat = new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
const dayKeyFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : 'Có lỗi xảy ra. Bạn thử lại nhé.';
}

function formatGroupDate(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const targetKey = dayKeyFormat.format(date);
  const todayKey = dayKeyFormat.format(now);
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const yesterdayKey = dayKeyFormat.format(yesterday);

  const day = date.getDate();
  const month = date.getMonth() + 1;
  const year = date.getFullYear();

  if (targetKey === todayKey) return `Hôm nay, ${day} Thg ${month}`;
  if (targetKey === yesterdayKey) return `Hôm qua, ${day} Thg ${month}`;
  return `${day} Thg ${month}, ${year}`;
}

function formatFullStamp(iso: string): string {
  const date = new Date(iso);
  const day = date.getDate();
  const month = date.getMonth() + 1;
  const year = date.getFullYear();
  return `${day} Thg ${month}, ${year} · ${timeFormat.format(date)}`;
}

function formatSeatMeta(entry: Pick<JournalEntry, 'tableLabel' | 'floor'>): string {
  if (!entry.tableLabel) return '';
  return entry.floor ? `Bàn ${entry.tableLabel}, Tầng ${entry.floor}` : `Bàn ${entry.tableLabel}`;
}

export function JournalPanel({ currentSeat }: { currentSeat?: CurrentSeat | null }) {
  const [data, setData] = useState<JournalState>();
  const [needsQr, setNeedsQr] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [filter, setFilter] = useState<FilterTab>('all');
  const [viewMode, setViewMode] = useState<ViewMode>('album');

  // Upload screen state
  const [uploadingOpen, setUploadingOpen] = useState(false);
  const [drafts, setDrafts] = useState<CompressedPhotoDraft[]>([]);
  const [activeDraftIdx, setActiveDraftIdx] = useState(0);
  const [note, setNote] = useState('');
  const [attachTable, setAttachTable] = useState(Boolean(currentSeat));
  const [compressing, setCompressing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploadError, setUploadError] = useState('');

  // Darkroom lightbox state
  const [viewer, setViewer] = useState<ViewerState | null>(null);
  const [editingNote, setEditingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [viewerBusy, setViewerBusy] = useState(false);
  const [viewerError, setViewerError] = useState('');
  const [toast, setToast] = useState('');

  const libraryInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const draftsRef = useRef<CompressedPhotoDraft[]>([]);
  const touchStartX = useRef<number | null>(null);
  draftsRef.current = drafts;

  const showToast = useCallback((text: string) => {
    setToast(text);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 2400);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!confirmDelete) return;
    const timer = setTimeout(() => setConfirmDelete(false), 3200);
    return () => clearTimeout(timer);
  }, [confirmDelete]);

  // Revoke any remaining blob preview URLs on unmount
  useEffect(() => {
    return () => {
      for (const item of draftsRef.current) URL.revokeObjectURL(item.previewUrl);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    api<JournalState>('/api/journal', { signal: controller.signal })
      .then((next) => {
        setData(next);
        setNeedsQr(false);
        setLoadError('');
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        if (failure instanceof ApiError && failure.status === 401) setNeedsQr(true);
        else setLoadError(messageOf(failure));
      });
    return () => controller.abort();
  }, [attempt]);

  const clearDrafts = useCallback(() => {
    for (const item of draftsRef.current) URL.revokeObjectURL(item.previewUrl);
    setDrafts([]);
    setActiveDraftIdx(0);
    setNote('');
    setUploadError('');
  }, []);

  function openUpload() {
    setUploadError('');
    setAttachTable(Boolean(currentSeat));
    setUploadingOpen(true);
  }

  function closeUpload() {
    if (saving) return;
    clearDrafts();
    setUploadingOpen(false);
  }

  async function handleFilesPicked(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (!files.length) return;

    const remaining = journalMaxPhotosPerEntry - draftsRef.current.length;
    if (remaining <= 0) {
      setUploadError(`Mỗi lần lưu tối đa ${journalMaxPhotosPerEntry} ảnh.`);
      return;
    }

    const chosen = files.slice(0, remaining);
    if (files.length > remaining) {
      setUploadError(`Đã chọn ${remaining} ảnh đầu tiên (tối đa ${journalMaxPhotosPerEntry} ảnh mỗi lần lưu).`);
    } else {
      setUploadError('');
    }

    setCompressing(true);
    setAttachTable((prev) => (uploadingOpen ? prev : Boolean(currentSeat)));
    setUploadingOpen(true);

    const added: CompressedPhotoDraft[] = [];
    const errors: string[] = [];
    for (const file of chosen) {
      try {
        added.push(await compressJournalPhoto(file));
      } catch (failure) {
        errors.push(messageOf(failure));
      }
    }

    if (added.length > 0) {
      setDrafts((previous) => {
        const next = [...previous, ...added].slice(0, journalMaxPhotosPerEntry);
        if (previous.length === 0) setActiveDraftIdx(0);
        return next;
      });
    }
    if (errors.length > 0) {
      setUploadError(errors[0]);
    }
    setCompressing(false);
  }

  function removeDraft(index: number) {
    setDrafts((previous) => {
      const target = previous[index];
      if (target) URL.revokeObjectURL(target.previewUrl);
      const next = previous.filter((_, idx) => idx !== index);
      setActiveDraftIdx((current) => Math.max(0, Math.min(current, next.length - 1)));
      return next;
    });
    setUploadError('');
  }

  async function savePhotos(event?: FormEvent) {
    event?.preventDefault();
    if (saving || compressing) return;
    if (drafts.length === 0) {
      setUploadError('Hãy chọn hoặc chụp ít nhất 1 ảnh để lưu.');
      return;
    }

    setSaving(true);
    setUploadError('');
    try {
      const response = await api<{ entry: JournalEntry; summary: JournalState['summary'] }>('/api/journal', {
        method: 'POST',
        body: JSON.stringify({
          note: note.trim(),
          attachTable: Boolean(currentSeat && attachTable),
          photos: drafts.map((item) => ({
            dataBase64: item.dataBase64,
            mime: item.mime,
            width: item.width,
            height: item.height,
          })),
        }),
      });
      setData((previous) => ({
        entries: [response.entry, ...(previous?.entries ?? [])],
        summary: response.summary,
      }));
      const count = response.entry.photos.length;
      clearDrafts();
      setUploadingOpen(false);
      setFilter('all');
      showToast(count === 1 ? 'Đã lưu 1 ảnh vào nhật ký.' : `Đã lưu ${count} ảnh vào nhật ký.`);
    } catch (failure) {
      setUploadError(messageOf(failure));
    } finally {
      setSaving(false);
    }
  }

  // Visible entries & flattened photos based on filter
  const entries = data?.entries ?? [];
  const summary = data?.summary ?? { totalPhotos: 0, totalEntries: 0, visitCount: 0 };

  const visibleEntries = useMemo(() => {
    if (filter === 'all') return entries;
    return entries
      .map((entry) => ({ ...entry, photos: entry.photos.filter((photo) => photo.favorite) }))
      .filter((entry) => entry.photos.length > 0);
  }, [entries, filter]);

  const flatPhotos = useMemo(() => {
    const items: { entry: JournalEntry; photo: JournalPhoto }[] = [];
    for (const entry of visibleEntries) {
      for (const photo of entry.photos) {
        items.push({ entry, photo });
      }
    }
    return items;
  }, [visibleEntries]);

  // Resolve current lightbox entry & photo
  const viewerEntry = viewer ? entries.find((entry) => entry.id === viewer.entryId) : undefined;
  const viewerPhotos = viewerEntry
    ? (filter === 'favorite' ? viewerEntry.photos.filter((p) => p.favorite) : viewerEntry.photos)
    : [];
  const viewerPhotoIndex = viewer
    ? viewerPhotos.findIndex((photo) => photo.id === viewer.photoId)
    : -1;
  const viewerPhoto = viewerPhotoIndex >= 0 ? viewerPhotos[viewerPhotoIndex] : undefined;

  useEffect(() => {
    if (viewer && (!viewerEntry || !viewerPhoto)) {
      setViewer(null);
      setEditingNote(false);
      setConfirmDelete(false);
      setViewerError('');
    }
  }, [viewer, viewerEntry, viewerPhoto]);

  const stepViewer = useCallback((delta: number) => {
    if (!viewerEntry || viewerPhotos.length <= 1 || viewerPhotoIndex < 0) return;
    const nextIdx = (viewerPhotoIndex + delta + viewerPhotos.length) % viewerPhotos.length;
    setViewer({ entryId: viewerEntry.id, photoId: viewerPhotos[nextIdx].id });
    setConfirmDelete(false);
    setViewerError('');
  }, [viewerEntry, viewerPhotos, viewerPhotoIndex]);

  useEffect(() => {
    if (!viewer || editingNote) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setViewer(null);
        setConfirmDelete(false);
      } else if (event.key === 'ArrowLeft') {
        stepViewer(-1);
      } else if (event.key === 'ArrowRight') {
        stepViewer(1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [viewer, editingNote, stepViewer]);

  function openPhoto(entryId: string, photoId: string) {
    setViewer({ entryId, photoId });
    setEditingNote(false);
    setConfirmDelete(false);
    setViewerError('');
  }

  async function toggleFavorite(photoId: string) {
    if (viewerBusy) return;
    setViewerBusy(true);
    setViewerError('');
    try {
      const next = await api<JournalState>(`/api/journal/photos/${photoId}/favorite`, { method: 'PATCH' });
      setData(next);
    } catch (failure) {
      setViewerError(messageOf(failure));
    } finally {
      setViewerBusy(false);
    }
  }

  async function saveEditedNote(event: FormEvent) {
    event.preventDefault();
    if (!viewerEntry || viewerBusy) return;
    setViewerBusy(true);
    setViewerError('');
    try {
      const next = await api<JournalState>(`/api/journal/${viewerEntry.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ note: noteDraft.trim() }),
      });
      setData(next);
      setEditingNote(false);
      showToast('Đã cập nhật ghi chú.');
    } catch (failure) {
      setViewerError(messageOf(failure));
    } finally {
      setViewerBusy(false);
    }
  }

  async function deleteActivePhoto() {
    if (!viewerEntry || !viewerPhoto || viewerBusy) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setViewerBusy(true);
    setViewerError('');
    try {
      const siblingAfter = viewerPhotos[viewerPhotoIndex + 1] ?? viewerPhotos[viewerPhotoIndex - 1];
      const next = await api<JournalState>(`/api/journal/photos/${viewerPhoto.id}`, { method: 'DELETE' });
      setData(next);
      setConfirmDelete(false);
      if (siblingAfter) {
        setViewer({ entryId: viewerEntry.id, photoId: siblingAfter.id });
      } else {
        setViewer(null);
      }
      showToast('Đã xóa ảnh khỏi nhật ký.');
    } catch (failure) {
      setViewerError(messageOf(failure));
    } finally {
      setViewerBusy(false);
    }
  }

  async function deleteLegacyEntry(entryId: string) {
    if (!window.confirm('Xóa ghi chép này khỏi nhật ký của bạn?')) return;
    try {
      const next = await api<JournalState>(`/api/journal/${entryId}`, { method: 'DELETE' });
      setData(next);
      showToast('Đã xóa ghi chép.');
    } catch (failure) {
      setLoadError(messageOf(failure));
    }
  }

  function handleLightboxTouchStart(event: TouchEvent) {
    touchStartX.current = event.touches[0]?.clientX ?? null;
  }

  function handleLightboxTouchEnd(event: TouchEvent) {
    if (touchStartX.current === null || editingNote) return;
    const endX = event.changedTouches[0]?.clientX ?? touchStartX.current;
    const delta = endX - touchStartX.current;
    touchStartX.current = null;
    if (Math.abs(delta) >= 42) {
      stepViewer(delta < 0 ? 1 : -1);
    }
  }

  const hiddenFileInputs = (
    <>
      <input
        ref={libraryInputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(event) => void handleFilesPicked(event)}
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(event) => void handleFilesPicked(event)}
      />
    </>
  );

  // ==================== SCREEN 2: UPLOAD / SAVE PHOTOS ====================
  if (uploadingOpen) {
    const activeDraft = drafts[activeDraftIdx] ?? drafts[0];
    const remainingSlots = journalMaxPhotosPerEntry - drafts.length;
    const seatDateLabel = shortDateFormat.format(new Date());

    return (
      <section className="jp-upload" aria-labelledby="jp-upload-title">
        {hiddenFileInputs}
        <header className="jp-upload__head">
          <button type="button" className="jp-upload__cancel" onClick={closeUpload} disabled={saving}>
            Hủy
          </button>
          <h1 id="jp-upload-title" className="jp-upload__title">Lưu ảnh mới</h1>
          <button
            type="button"
            className="jp-upload__save"
            disabled={saving || compressing || drafts.length === 0}
            onClick={() => void savePhotos()}
          >
            {saving ? 'Đang lưu…' : drafts.length > 0 ? `Lưu (${drafts.length})` : 'Lưu'}
          </button>
        </header>

        <form className="jp-upload__body" onSubmit={(event) => void savePhotos(event)}>
          {activeDraft ? (
            <div className="jp-preview">
              <img src={activeDraft.previewUrl} alt={`Ảnh xem trước ${activeDraftIdx + 1}`} />
              <span className="jp-preview__idx">{activeDraftIdx + 1} / {drafts.length}</span>
              <button
                type="button"
                className="jp-preview__del"
                aria-label="Bỏ ảnh này"
                disabled={saving}
                onClick={() => removeDraft(activeDraftIdx)}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
          ) : (
            <div className="jp-preview jp-preview--empty">
              <div className="jp-preview__empty-inner">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="4" width="18" height="16" rx="2.5" />
                  <circle cx="8.5" cy="9.5" r="1.4" />
                  <path d="m21 15-4.5-4.5L7 20" />
                </svg>
                <strong>{compressing ? 'Đang xử lý ảnh…' : 'Chọn hoặc chụp ảnh kỷ niệm'}</strong>
                <p>Tối đa {journalMaxPhotosPerEntry} ảnh mỗi lần lưu · Tự động tối ưu dung lượng</p>
                <div className="jp-preview__empty-actions">
                  <button type="button" className="jp-btn jp-btn--green" disabled={compressing} onClick={() => libraryInputRef.current?.click()}>
                    Chọn từ thư viện
                  </button>
                  <button type="button" className="jp-btn" disabled={compressing} onClick={() => cameraInputRef.current?.click()}>
                    Chụp ảnh
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="jp-strip" role="list" aria-label="Ảnh đã chọn">
            {drafts.map((item, index) => (
              <button
                key={item.localId}
                type="button"
                role="listitem"
                className={`jp-slot${index === activeDraftIdx ? ' is-selected' : ''}`}
                aria-label={`Xem ảnh ${index + 1}`}
                aria-pressed={index === activeDraftIdx}
                onClick={() => setActiveDraftIdx(index)}
              >
                <img src={item.previewUrl} alt="" />
              </button>
            ))}
            {remainingSlots > 0 && (
              <>
                <button
                  type="button"
                  className="jp-slot jp-slot--action"
                  disabled={saving || compressing}
                  onClick={() => libraryInputRef.current?.click()}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="3" y="4" width="18" height="16" rx="2.5" />
                    <circle cx="8.5" cy="9.5" r="1.4" />
                    <path d="m21 15-4.5-4.5L7 20" />
                  </svg>
                  <span>Thư viện</span>
                </button>
                <button
                  type="button"
                  className="jp-slot jp-slot--action"
                  disabled={saving || compressing}
                  onClick={() => cameraInputRef.current?.click()}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M4 8a2 2 0 0 1 2-2h2.2l1.4-2h4.8l1.4 2H18a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8Z" />
                    <circle cx="12" cy="13" r="3" />
                  </svg>
                  <span>Chụp ảnh</span>
                </button>
              </>
            )}
          </div>

          {compressing && <p className="jp-status" role="status">Đang tối ưu dung lượng ảnh…</p>}
          {uploadError && <p className="form-error" role="alert">{uploadError}</p>}

          <div className="jp-note-box">
            <div className="jp-note-box__top">
              <label htmlFor="jp-note-input" className="jp-note-box__label">Ghi chú ngắn (tùy chọn)</label>
              <span className="jp-note-box__count">{[...note].length} / {journalMaxNoteLength}</span>
            </div>
            <textarea
              id="jp-note-input"
              className="jp-note-box__input"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Thêm vài chữ kỷ niệm cho khoảnh khắc này…"
              maxLength={journalMaxNoteLength}
              rows={2}
              disabled={saving}
            />
          </div>

          {currentSeat && (
            <div className="jp-seat-row">
              <span className="jp-seat-row__info">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 21s-6-5.3-6-10a6 6 0 1 1 12 0c0 4.7-6 10-6 10Z" />
                  <circle cx="12" cy="11" r="2" />
                </svg>
                <span>Bàn {currentSeat.label}, Tầng {currentSeat.floor} <small>· {seatDateLabel}</small></span>
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={attachTable}
                aria-label="Gắn vị trí bàn hiện tại"
                className={`jp-switch${attachTable ? ' is-on' : ''}`}
                disabled={saving}
                onClick={() => setAttachTable((value) => !value)}
              >
                <span className="jp-switch__knob" />
              </button>
            </div>
          )}

          <div className="jp-priv">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="5" y="11" width="14" height="10" rx="2" />
              <path d="M8 11V7a4 4 0 0 1 8 0v4" />
            </svg>
            <span>Ảnh lưu riêng trong nhật ký cá nhân trên trình duyệt này, không hiển thị với khách khác.</span>
          </div>
        </form>
      </section>
    );
  }

  // ==================== SCREEN 1: PERSONAL PHOTO ALBUM ====================
  return (
    <section className="jp-shell" aria-labelledby="jp-title">
      {hiddenFileInputs}

      <header className="jp-head">
        <div className="jp-head__left">
          <h1 id="jp-title" className="jp-head__brand">
            <img src="/art/xconnect.webp" alt="XConnect" />
          </h1>
          <span className="jp-head__sub">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="5" y="11" width="14" height="10" rx="2" />
              <path d="M8 11V7a4 4 0 0 1 8 0v4" />
            </svg>
            {needsQr
              ? 'Album riêng của bạn'
              : `Album riêng · ${summary.totalPhotos} ảnh${summary.visitCount > 0 ? ` · ${summary.visitCount} lần ghé` : ''}`}
          </span>
        </div>
        {!needsQr && data && (
          <button type="button" className="jp-add-btn" onClick={openUpload}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
            <span>Lưu ảnh</span>
          </button>
        )}
      </header>

      {!needsQr && data && (
        <div className="jp-bar">
          <div className="jp-tabs" role="tablist" aria-label="Lọc ảnh nhật ký">
            <button
              type="button"
              role="tab"
              aria-selected={filter === 'all'}
              className={`jp-tab${filter === 'all' ? ' is-active' : ''}`}
              onClick={() => setFilter('all')}
            >
              Tất cả
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={filter === 'favorite'}
              className={`jp-tab${filter === 'favorite' ? ' is-active' : ''}`}
              onClick={() => setFilter('favorite')}
            >
              Yêu thích
            </button>
          </div>
          <div className="jp-view-switch" role="group" aria-label="Chế độ hiển thị ảnh">
            <button
              type="button"
              className={`jp-view-btn${viewMode === 'album' ? ' is-active' : ''}`}
              aria-pressed={viewMode === 'album'}
              aria-label="Xem theo từng lần ghé"
              title="Theo từng lần ghé"
              onClick={() => setViewMode('album')}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="8" height="18" rx="1.5" />
                <rect x="14" y="3" width="7" height="8" rx="1.5" />
                <rect x="14" y="14" width="7" height="7" rx="1.5" />
              </svg>
            </button>
            <button
              type="button"
              className={`jp-view-btn${viewMode === 'grid' ? ' is-active' : ''}`}
              aria-pressed={viewMode === 'grid'}
              aria-label="Xem lưới vuông"
              title="Lưới ảnh"
              onClick={() => setViewMode('grid')}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3.5" y="3.5" width="7" height="7" rx="1.2" />
                <rect x="13.5" y="3.5" width="7" height="7" rx="1.2" />
                <rect x="3.5" y="13.5" width="7" height="7" rx="1.2" />
                <rect x="13.5" y="13.5" width="7" height="7" rx="1.2" />
              </svg>
            </button>
          </div>
        </div>
      )}

      <div className="jp-scroll">
        {toast && <p className="jp-toast" role="status">{toast}</p>}
        {loadError && <p className="form-error" role="alert">{loadError}</p>}

        {needsQr ? (
          <div className="jp-empty">
            <div className="jp-empty__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <rect x="5" y="11" width="14" height="10" rx="2" />
                <path d="M8 11V7a4 4 0 0 1 8 0v4" />
              </svg>
            </div>
            <strong>Quét mã QR tại bàn để mở Nhật ký</strong>
            <p>Mỗi khách có một album ảnh riêng tư lưu trên trình duyệt đã quét mã QR tại Xưởng.</p>
          </div>
        ) : !data ? (
          loadError ? (
            <div className="jp-empty">
              <button type="button" className="jp-btn jp-btn--green" onClick={() => { setLoadError(''); setAttempt((n) => n + 1); }}>
                Tải lại nhật ký
              </button>
            </div>
          ) : (
            <p className="jp-loading" role="status">Đang mở album nhật ký…</p>
          )
        ) : entries.length === 0 ? (
          <div className="jp-empty">
            <div className="jp-empty__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 8a2 2 0 0 1 2-2h2.2l1.4-2h4.8l1.4 2H18a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8Z" />
                <circle cx="12" cy="13" r="3.2" />
              </svg>
            </div>
            <strong>Lưu giữ khoảnh khắc riêng tại Xưởng</strong>
            <p>Chụp ly cà phê, góc bàn yêu thích hoặc buổi gặp mặt. Ảnh lưu riêng cho cá nhân bạn.</p>
            <div className="jp-empty__actions">
              <button type="button" className="jp-btn jp-btn--green" onClick={() => libraryInputRef.current?.click()}>
                Chọn từ thư viện
              </button>
              <button type="button" className="jp-btn" onClick={() => cameraInputRef.current?.click()}>
                Chụp ảnh ngay
              </button>
            </div>
          </div>
        ) : visibleEntries.length === 0 ? (
          <div className="jp-empty jp-empty--compact">
            <strong>Chưa có ảnh yêu thích nào</strong>
            <p>Chạm vào biểu tượng trái tim khi xem ảnh để lưu vào mục Yêu thích.</p>
          </div>
        ) : viewMode === 'grid' ? (
          flatPhotos.length > 0 ? (
            <div className="jp-grid" role="list" aria-label="Lưới ảnh cá nhân">
              {flatPhotos.map(({ entry, photo }) => (
                <button
                  key={photo.id}
                  type="button"
                  role="listitem"
                  className="jp-grid__cell"
                  aria-label={`Xem ảnh chụp ngày ${formatGroupDate(entry.createdAt)}`}
                  onClick={() => openPhoto(entry.id, photo.id)}
                >
                  <img src={photo.url} alt={entry.body || 'Ảnh kỷ niệm tại Xưởng'} loading="lazy" />
                  {photo.favorite && (
                    <span className="jp-tile__fav" aria-hidden="true">
                      <svg viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 20.5s-7.5-4.7-9.3-9A5.4 5.4 0 0 1 12 6.2a5.4 5.4 0 0 1 9.3 5.3c-1.8 4.3-9.3 9-9.3 9Z" />
                      </svg>
                    </span>
                  )}
                </button>
              ))}
            </div>
          ) : (
            <div className="jp-empty jp-empty--compact">
              <strong>Chưa có ảnh nào</strong>
              <p>Bấm “Lưu ảnh” ở góc trên để thêm tấm ảnh đầu tiên vào album của bạn.</p>
            </div>
          )
        ) : (
          <div className="jp-feed">
            {visibleEntries.map((entry) => {
              const seatMeta = formatSeatMeta(entry);
              const metaStamp = `${timeFormat.format(new Date(entry.createdAt))}${seatMeta ? ` · ${seatMeta}` : ''}`;

              if (entry.photos.length === 0) {
                return (
                  <article key={entry.id} className="jp-legacy-card">
                    <div className="jp-group__head">
                      <span className="jp-group__date">{formatGroupDate(entry.createdAt)}</span>
                      <span className="jp-group__meta">{metaStamp}</span>
                    </div>
                    {entry.title && <h2 className="jp-legacy-card__title">{entry.title}</h2>}
                    <p className="jp-legacy-card__body">{entry.body}</p>
                    <button type="button" className="jp-legacy-card__del" onClick={() => void deleteLegacyEntry(entry.id)}>
                      Xóa ghi chép
                    </button>
                  </article>
                );
              }

              const layoutClass = entry.photos.length === 1
                ? 'jp-photos jp-photos--1'
                : entry.photos.length === 2
                  ? 'jp-photos jp-photos--2'
                  : entry.photos.length === 3
                    ? 'jp-photos jp-photos--3'
                    : 'jp-photos jp-photos--4';

              return (
                <article key={entry.id} className="jp-group">
                  <div className="jp-group__head">
                    <span className="jp-group__date">{formatGroupDate(entry.createdAt)}</span>
                    <span className="jp-group__meta">{metaStamp}</span>
                  </div>
                  <div className={layoutClass}>
                    {entry.photos.map((photo, index) => (
                      <button
                        key={photo.id}
                        type="button"
                        className={`jp-tile${entry.photos.length === 3 && index === 0 ? ' jp-tile--tall' : ''}`}
                        aria-label={`Xem ảnh ${index + 1} ngày ${formatGroupDate(entry.createdAt)}`}
                        onClick={() => openPhoto(entry.id, photo.id)}
                      >
                        <img src={photo.url} alt={entry.body || 'Ảnh kỷ niệm tại Xưởng'} loading="lazy" />
                        {photo.favorite && (
                          <span className="jp-tile__fav" aria-hidden="true">
                            <svg viewBox="0 0 24 24" fill="currentColor">
                              <path d="M12 20.5s-7.5-4.7-9.3-9A5.4 5.4 0 0 1 12 6.2a5.4 5.4 0 0 1 9.3 5.3c-1.8 4.3-9.3 9-9.3 9Z" />
                            </svg>
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                  {entry.body && <p className="jp-caption">{entry.body}</p>}
                </article>
              );
            })}
          </div>
        )}
      </div>

      {/* ==================== SCREEN 3: DARKROOM LIGHTBOX ==================== */}
      {viewer && viewerEntry && viewerPhoto && (
        <div
          className="jp-darkroom"
          role="dialog"
          aria-modal="true"
          aria-label="Xem ảnh kỷ niệm"
          onTouchStart={handleLightboxTouchStart}
          onTouchEnd={handleLightboxTouchEnd}
        >
          <header className="jp-darkroom__head">
            <div className="jp-darkroom__left">
              <button
                type="button"
                className="jp-darkroom__back"
                aria-label="Quay lại album"
                onClick={() => {
                  setViewer(null);
                  setEditingNote(false);
                  setConfirmDelete(false);
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m15 18-6-6 6-6" />
                </svg>
              </button>
              <div className="jp-darkroom__meta">
                <strong>{formatFullStamp(viewerEntry.createdAt)}</strong>
                <span>{formatSeatMeta(viewerEntry) ? `${formatSeatMeta(viewerEntry)} · Riêng tư` : 'Riêng tư'}</span>
              </div>
            </div>
            {viewerPhotos.length > 1 && (
              <span className="jp-darkroom__idx">{viewerPhotoIndex + 1} / {viewerPhotos.length}</span>
            )}
          </header>

          <div className="jp-darkroom__stage">
            {viewerPhotos.length > 1 && (
              <button
                type="button"
                className="jp-darkroom__nav jp-darkroom__nav--prev"
                aria-label="Ảnh trước"
                onClick={() => stepViewer(-1)}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m15 18-6-6 6-6" />
                </svg>
              </button>
            )}
            <img
              className="jp-darkroom__img"
              src={viewerPhoto.url}
              alt={viewerEntry.body || 'Ảnh kỷ niệm tại Xưởng'}
            />
            {viewerPhotos.length > 1 && (
              <button
                type="button"
                className="jp-darkroom__nav jp-darkroom__nav--next"
                aria-label="Ảnh tiếp theo"
                onClick={() => stepViewer(1)}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m9 18 6-6-6-6" />
                </svg>
              </button>
            )}
          </div>

          <footer className="jp-darkroom__foot">
            {viewerError && <p className="jp-darkroom__error" role="alert">{viewerError}</p>}

            {editingNote ? (
              <form className="jp-darkroom__editor" onSubmit={(event) => void saveEditedNote(event)}>
                <textarea
                  value={noteDraft}
                  onChange={(event) => setNoteDraft(event.target.value)}
                  placeholder="Viết ghi chú ngắn cho ảnh này…"
                  maxLength={journalMaxNoteLength}
                  rows={2}
                  autoFocus
                  disabled={viewerBusy}
                />
                <div className="jp-darkroom__editor-row">
                  <span>{[...noteDraft].length} / {journalMaxNoteLength}</span>
                  <div>
                    <button type="button" className="jp-darkroom__small-btn" disabled={viewerBusy} onClick={() => setEditingNote(false)}>
                      Hủy
                    </button>
                    <button type="submit" className="jp-darkroom__small-btn is-save" disabled={viewerBusy}>
                      {viewerBusy ? 'Đang lưu…' : 'Lưu'}
                    </button>
                  </div>
                </div>
              </form>
            ) : (
              viewerEntry.body && <p className="jp-darkroom__caption">{viewerEntry.body}</p>
            )}

            {viewerPhotos.length > 1 && !editingNote && (
              <div className="jp-darkroom__filmstrip" role="list" aria-label="Danh sách ảnh cùng lần lưu">
                {viewerPhotos.map((item, idx) => (
                  <button
                    key={item.id}
                    type="button"
                    role="listitem"
                    className={`jp-darkroom__thumb${item.id === viewerPhoto.id ? ' is-active' : ''}`}
                    aria-label={`Chọn ảnh ${idx + 1}`}
                    onClick={() => {
                      setViewer({ entryId: viewerEntry.id, photoId: item.id });
                      setConfirmDelete(false);
                    }}
                  >
                    <img src={item.url} alt="" />
                  </button>
                ))}
              </div>
            )}

            <div className="jp-darkroom__actions">
              <button
                type="button"
                className={`jp-dact${viewerPhoto.favorite ? ' is-fav' : ''}`}
                disabled={viewerBusy}
                aria-pressed={viewerPhoto.favorite}
                onClick={() => void toggleFavorite(viewerPhoto.id)}
              >
                <span className="jp-dact__icon">
                  <svg viewBox="0 0 24 24" fill={viewerPhoto.favorite ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 20.5s-7.5-4.7-9.3-9A5.4 5.4 0 0 1 12 6.2a5.4 5.4 0 0 1 9.3 5.3c-1.8 4.3-9.3 9-9.3 9Z" />
                  </svg>
                </span>
                <span>Yêu thích</span>
              </button>

              <a
                className="jp-dact is-primary"
                href={viewerPhoto.downloadUrl}
                download
                onClick={() => showToast('Đang tải ảnh về máy…')}
              >
                <span className="jp-dact__icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 3v12m0 0-4-4m4 4 4-4M4 19h16" />
                  </svg>
                </span>
                <span>Lưu về máy</span>
              </a>

              <button
                type="button"
                className="jp-dact"
                disabled={viewerBusy}
                onClick={() => {
                  setNoteDraft(viewerEntry.body);
                  setEditingNote((prev) => !prev);
                  setConfirmDelete(false);
                }}
              >
                <span className="jp-dact__icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 20h9" />
                    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5Z" />
                  </svg>
                </span>
                <span>Ghi chú</span>
              </button>

              <button
                type="button"
                className={`jp-dact${confirmDelete ? ' is-danger' : ''}`}
                disabled={viewerBusy}
                onClick={() => void deleteActivePhoto()}
              >
                <span className="jp-dact__icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
                  </svg>
                </span>
                <span>{confirmDelete ? 'Xác nhận?' : 'Xóa ảnh'}</span>
              </button>
            </div>
          </footer>
        </div>
      )}
    </section>
  );
}
