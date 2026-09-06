import { useEffect, useRef } from 'react';
import { ArrowSquareOut, X, Circle, CheckCircle, WarningCircle, Clock } from '@phosphor-icons/react';

export function Avatar({ name = 'Maya', size = 'normal', agent = false }) {
  return <span className={`p-avatar p-avatar-${size} ${agent ? 'p-avatar-agent' : name === 'Maya' ? 'p-avatar-maya' : ''}`} aria-label={name}>{agent ? <img src="/assets/plexus-symbol.svg" alt="" /> : name.slice(0, 1)}</span>;
}
export function Status({ children, tone = 'neutral', icon = false }) {
  const Icon = tone === 'success' ? CheckCircle : tone === 'warning' ? WarningCircle : Clock;
  return <span className={`p-status p-status-${tone}`}>{icon ? <Icon size={16} /> : <Circle size={7} weight="fill" />}{children}</span>;
}
export function Button({ children, variant = 'secondary', className = '', ...props }) {
  return <button className={`p-button p-button-${variant} ${className}`} {...props}>{children}</button>;
}
export function SourceLink({ children = 'View source', onClick }) {
  return <button className="p-source" onClick={onClick}>{children}<ArrowSquareOut size={14} /></button>;
}
export function Modal({ title, children, onClose, wide = false }) {
  const ref = useRef(null);
  useEffect(() => { const dialog = ref.current; dialog.showModal(); return () => dialog.close(); }, []);
  return <dialog ref={ref} className={`p-modal ${wide ? 'p-modal-wide' : ''}`} onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }} aria-labelledby="dialog-title">
    <header><h2 id="dialog-title">{title}</h2><button className="p-icon-button" onClick={onClose} aria-label="Close dialog"><X size={20} /></button></header>
    <div className="p-modal-body">{children}</div>
  </dialog>;
}
