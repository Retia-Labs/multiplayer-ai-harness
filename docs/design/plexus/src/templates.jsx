import { useRef, useState } from 'react';
import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { ArrowRight, ArrowSquareOut, CheckCircle, Code, Copy, DownloadSimple, FileCode, Monitor, ShieldCheck, SquaresFour, Users } from '@phosphor-icons/react';
import { Avatar, Button, Modal, SourceLink, Status } from './ui.jsx';
import tokens from '../design/plexus-app.tokens.json';
import catalog from '../design/screen-templates.json';
import './templates.css';

gsap.registerPlugin(useGSAP, ScrollTrigger);
const routes = {shell:'workspace',review:'review',evidence:'catchup',decision:'approval',inbox:'inbox',setup:'setup'};
const icons = {shell:SquaresFour,review:FileCode,evidence:Code,decision:ShieldCheck,inbox:Users,setup:Monitor};
function Specimen({ id }) {
  if (id === 'shell') return <div className="t-specimen-shell"><div><span>Storefront</span><strong>Checkout recovery</strong><small>In progress · Alex</small></div><section><p>Shared work, in view.</p><Status tone="success">Alex’s Mac · Connected</Status></section></div>;
  if (id === 'review') return <div className="t-mini-diff"><span><FileCode size={14} /> retry.ts</span><code className="t-minus">− const key = createPaymentKey();</code><code className="t-plus">+ const key = checkout.paymentKey;</code><small><CheckCircle size={14} /> Changes connected to their context</small></div>;
  if (id === 'evidence') return <div className="t-evidence"><Avatar size="small" /><div><strong>Reuse the original payment key.</strong><p>Maya · Recorded decision</p><small>Updated 20s ago · event 28</small></div><ArrowSquareOut size={15} /></div>;
  if (id === 'decision') return <div className="t-decision"><span><ShieldCheck size={18} /> One action. One decision.</span><code>npm test -- retry.test.ts</code><small>Storefront · Alex’s Mac · turn 4</small><Status tone="warning">Awaiting Maya’s approval</Status></div>;
  if (id === 'inbox') return <div className="t-evidence"><Avatar name="Alex" size="small" /><div><strong>Can you review the timeout case?</strong><p>Alex asked Maya</p><Status tone="warning">Human help request · Open</Status></div></div>;
  return <div className="t-setup"><Monitor size={27} /><div><strong>Your host. Your workspace.</strong><p>Verified device → shared project → Codex</p><Status tone="success">Ready to start alone</Status></div></div>;
}
export function TemplatesScreen({onNavigate}) {
  const [selected,setSelected] = useState(null);
  const [copied,setCopied] = useState(false);
  const scope = useRef(null);
  useGSAP(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const scroller = scope.current.closest('.p-management-area');
    gsap.utils.toArray('.t-template').forEach(element => gsap.fromTo(element, {y:12}, {y:0,duration:.35,scrollTrigger:{trigger:element,scroller,start:'top 96%',toggleActions:'play none none none'}}));
  },{scope});
  async function copyContract() { try { await navigator.clipboard.writeText(JSON.stringify(selected,null,2)); setCopied(true); } catch { setCopied(false); } }
  return <div className="t-library" ref={scope}><header className="t-heading"><div><span className="t-kicker">Plexus design system</span><h1>A shared language for shared work.</h1><p>Composable screens, clear states, and the details that keep the product coherent.</p></div><a className="p-button" href="/exports/plexus-app.tokens.json" download><DownloadSimple size={16} />Export tokens</a></header>
    <section className="t-foundation"><div><h2>Quiet by design.</h2><p>Outfit typography. Graphite surfaces. Pale green where an action matters.</p><div className="t-guide-links"><a href="/exports/DESIGN-SYSTEM.md" download className="p-source">Design guide <ArrowSquareOut size={14} /></a><a href="/exports/DEVELOPMENT-HANDOFF.md" download className="p-source">Development handoff <ArrowSquareOut size={14} /></a></div></div><div className="t-swatches">{[['Canvas',tokens.color.background],['Surface',tokens.color.surface],['Raised',tokens.color.raised],['Text',tokens.color.ink],['Accent',tokens.color.accent]].map(([label,color])=><div key={label}><span style={{backgroundColor:color}} /><strong>{label}</strong><small>{color.toUpperCase()}</small></div>)}</div></section>
    <div className="t-section-title"><h2>Screen templates</h2><a className="p-source" href="/exports/screen-templates.json" download>Download contracts <DownloadSimple size={14} /></a></div>
    <section className="t-grid" aria-label="Reusable screen templates">{catalog.templates.map(template=>{const Icon=icons[template.id];return <article className="t-template" key={template.id}><div className="t-template-preview"><Specimen id={template.id} /></div><div className="t-template-content"><span><Icon size={17} />{template.name}</span><p>{template.purpose}</p><footer><button onClick={()=>{setSelected(template);setCopied(false);}}>Inspect template <Code size={14} /></button><button onClick={()=>onNavigate(routes[template.id])} aria-label={`Open ${template.name} screen`}><ArrowRight size={18} /></button></footer></div></article>;})}</section>
    <section className="t-state-section"><div><h2>States that mean what they say.</h2><p>Connectivity, execution, and permission are separate facts.</p></div><div className="t-state-examples"><Status tone="success" icon>Delivered to Codex · turn 4</Status><Status tone="warning" icon>Interrupt requested · waiting for host</Status><Status tone="warning" icon>Revocation pending acknowledgment</Status></div></section>
    <footer className="t-library-footer"><p>Built from the Plexus brand and the selected review direction.</p><button className="p-source" onClick={()=>onNavigate('review')}>Return to the workbench <ArrowRight size={15} /></button></footer>
    {selected && <Modal title={selected.name} onClose={()=>setSelected(null)} wide><p>{selected.purpose}</p><h3 className="t-modal-title">Required structure</h3><div className="t-slots">{selected.slots.map(slot=><div key={slot.name}><code>{slot.name}</code><p>{slot.content}</p><span>{slot.required?'Required':'Optional'}</span></div>)}</div><h3 className="t-modal-title">Meaning to preserve</h3><ul className="t-semantics">{selected.semantics.map(text=><li key={text}>{text}</li>)}</ul><div className="p-form-actions"><Button onClick={copyContract}><Copy size={15} />{copied?'Contract copied':'Copy JSON contract'}</Button><Button variant="primary" onClick={()=>{setSelected(null);onNavigate(routes[selected.id]);}}>Open screen <ArrowRight size={16} /></Button></div></Modal>}
  </div>;
}
