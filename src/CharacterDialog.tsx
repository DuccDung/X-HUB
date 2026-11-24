import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { CharacterSprite } from './CharacterSprite';
import { defaultCharacterOutfits } from './shared';
import type { CharacterModel, CharacterOutfit, GuestProfile } from './shared';
import './character-dialog.css';

const models = [
  { id: 'neutral', label: 'Trung tính', layer: 'Áo khoác' },
  { id: 'male', label: 'Nam', layer: 'Blazer' },
  { id: 'female', label: 'Nữ', layer: 'Blazer' },
] as const satisfies readonly { id: CharacterModel; label: string; layer: string }[];

const topChoices = [
  { value: 'olive', label: 'Olive', color: '#69734d' },
  { value: 'brown', label: 'Nâu', color: '#795846' },
  { value: 'rust', label: 'Đỏ đất', color: '#a35442' },
  { value: 'cream', label: 'Kem', color: '#e3d4b1' },
] as const;

const bottomChoices = [
  { value: 'charcoal', label: 'Than', color: '#484744' },
  { value: 'navy', label: 'Xanh navy', color: '#434e6d' },
  { value: 'sand', label: 'Cát', color: '#bca483' },
] as const;

const shoeChoices = [
  { value: 'sand', label: 'Cát', color: '#c3b096' },
  { value: 'coffee', label: 'Cà phê', color: '#725243' },
  { value: 'black', label: 'Đen', color: '#373634' },
] as const;

const presets = [
  { label: 'Olive hằng ngày', outfit: defaultCharacterOutfits.neutral },
  { label: 'Nâu cổ điển', outfit: defaultCharacterOutfits.male },
  { label: 'Đỏ đất', outfit: defaultCharacterOutfits.female },
  { label: 'Kem và xanh', outfit: { top: 'cream', bottom: 'navy', shoes: 'sand' } },
] as const satisfies readonly { label: string; outfit: CharacterOutfit }[];

const maxDisplayName = 24;

interface CharacterDialogProps {
  profile?: GuestProfile | null;
  onSave: (profile: GuestProfile) => Promise<void>;
  onClose: () => void;
}

interface ClothingChoicesProps<Value extends string> {
  label: string;
  value: Value;
  options: readonly { value: Value; label: string; color: string }[];
  onChange: (value: Value) => void;
}

function ClothingChoices<Value extends string>({ label, value, options, onChange }: ClothingChoicesProps<Value>) {
  return <fieldset className="character-dialog__choice-group">
    <legend>{label}</legend>
    <div className="character-dialog__choices">
      {options.map((option) => <button key={option.value} type="button" className="character-dialog__choice"
        aria-pressed={option.value === value} onClick={() => onChange(option.value)}>
        <span className="character-dialog__swatch" style={{ backgroundColor: option.color }} aria-hidden="true" />
        {option.label}
      </button>)}
    </div>
  </fieldset>;
}

function sameOutfit(first: CharacterOutfit, second: CharacterOutfit) {
  return first.top === second.top && first.bottom === second.bottom && first.shoes === second.shoes;
}

export function CharacterDialog({ profile, onSave, onClose }: CharacterDialogProps) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const [displayName, setDisplayName] = useState(profile?.displayName ?? '');
  const [model, setModel] = useState<CharacterModel>(profile?.model ?? 'neutral');
  const [outfits, setOutfits] = useState(() => profile
    ? { ...defaultCharacterOutfits, [profile.model]: profile.outfit }
    : defaultCharacterOutfits);
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState('');
  const [saveError, setSaveError] = useState('');
  const outfit = outfits[model];

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    node.showModal();
    heading.current?.focus({ preventScroll: true });
    return () => node.close();
  }, []);

  function updateOutfit(next: CharacterOutfit) {
    setOutfits((previous) => ({ ...previous, [model]: next }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const name = displayName.trim();
    const length = Array.from(name).length;
    if (!name || length > maxDisplayName || /[\p{Cc}]/u.test(name)) {
      setNameError(!name ? 'Nhập tên hiển thị của bạn.' : `Tên hiển thị cần có tối đa ${maxDisplayName} ký tự hợp lệ.`);
      nameInput.current?.focus();
      return;
    }

    setSaving(true);
    setSaveError('');
    try {
      await onSave({ displayName: name, model, outfit });
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Chưa lưu được nhân vật. Bạn thử lại nhé.');
    } finally {
      setSaving(false);
    }
  }

  return <dialog ref={dialog} className="character-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
    onCancel={(event) => { event.preventDefault(); if (!saving) onClose(); }}>
    <div className="character-dialog__handle" aria-hidden="true" />
    <header className="character-dialog__header">
      <h2 ref={heading} tabIndex={-1} id={`${id}-title`}>{profile ? 'Chỉnh nhân vật' : 'Tạo nhân vật'}</h2>
      <p id={`${id}-description`}>Chọn cách bạn xuất hiện trong quán.</p>
      <button className="character-dialog__close" type="button" aria-label="Đóng" onClick={onClose} disabled={saving}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
    </header>

    <form className="character-dialog__form" onSubmit={(event) => void submit(event)} noValidate aria-busy={saving}>
      <label className="character-dialog__name" htmlFor={`${id}-name`}>
        <span>Tên hiển thị</span>
        <input ref={nameInput} id={`${id}-name`} autoComplete="nickname" required maxLength={48} value={displayName}
          placeholder="Nhập tên của bạn" readOnly={saving} aria-invalid={Boolean(nameError)}
          aria-describedby={nameError ? `${id}-name-error` : undefined} onChange={(event) => {
            setDisplayName(event.target.value);
            if (nameError) setNameError('');
          }} />
      </label>
      {nameError && <p className="character-dialog__error" id={`${id}-name-error`} role="alert">{nameError}</p>}

      <fieldset className="character-dialog__models" disabled={saving}>
        <legend>Nhân vật</legend>
        <div className="character-dialog__model-grid">
          {models.map((option) => {
            const top = topChoices.find((choice) => choice.value === outfits[option.id].top);
            return <label key={option.id} className="character-dialog__model-option">
              <input className="character-dialog__radio" type="radio" name={`${id}-model`} checked={model === option.id}
                onChange={() => setModel(option.id)} aria-label={option.label} />
              <span className="character-dialog__model-card">
                <span className="character-dialog__check" aria-hidden="true">✓</span>
                <span className="character-dialog__preview"><CharacterSprite model={option.id} outfit={outfits[option.id]} /></span>
                <strong>{option.label}</strong>
                <small>{option.layer} {top?.label.toLocaleLowerCase('vi')}</small>
              </span>
            </label>;
          })}
        </div>
      </fieldset>

      <button type="button" className="character-dialog__wardrobe-toggle" aria-controls={`${id}-wardrobe`}
        aria-expanded={expanded} onClick={() => setExpanded((previous) => !previous)} disabled={saving}>
        <svg className="character-dialog__hanger" width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M9.5 8a2.5 2.5 0 1 1 4.21 1.82L12 11.4V13l8 4.5V19H4v-1.5l8-4.5" stroke="currentColor"
            strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span><strong>Trang phục và phụ kiện</strong><small>Áo, quần, giày và bộ phối sẵn</small></span>
        <span className="character-dialog__chevron" aria-hidden="true" />
      </button>
      <div id={`${id}-wardrobe`} className="character-dialog__wardrobe" hidden={!expanded}>
        <fieldset className="character-dialog__wardrobe-fields" disabled={saving}>
          <ClothingChoices label="Áo" value={outfit.top} options={topChoices} onChange={(top) => updateOutfit({ ...outfit, top })} />
          <ClothingChoices label="Quần" value={outfit.bottom} options={bottomChoices} onChange={(bottom) => updateOutfit({ ...outfit, bottom })} />
          <ClothingChoices label="Giày" value={outfit.shoes} options={shoeChoices} onChange={(shoes) => updateOutfit({ ...outfit, shoes })} />
          <fieldset className="character-dialog__choice-group">
            <legend>Bộ phối sẵn</legend>
            <div className="character-dialog__choices">
              {presets.map((preset) => <button key={preset.label} type="button" className="character-dialog__choice"
                aria-pressed={sameOutfit(outfit, preset.outfit)} onClick={() => updateOutfit(preset.outfit)}>{preset.label}</button>)}
            </div>
          </fieldset>
        </fieldset>
      </div>

      <div className="character-dialog__footer">
        {saveError && <p className="character-dialog__error" role="alert">{saveError}</p>}
        <button className="btn btn--green character-dialog__submit" type="submit" disabled={saving}>
          {saving ? 'Đang lưu…' : profile ? 'Lưu nhân vật' : 'Bước vào phòng'}
        </button>
      </div>
    </form>
  </dialog>;
}
