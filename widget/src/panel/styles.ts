// Panel CSS (Task 30). Everything lives in the shadow root; px only (themes set html { font-size: 62.5% }); the font is
// inherited (UD7). --ac / --ac-fg are set on .panel from the checked accent and textOn() (UD17).
// Input-like borders are #8a8a8a: 3.4:1 on white (WCAG 1.4.11). The textarea is 16px: iOS Safari zooms into smaller inputs.
/** UD4: below this viewport width (px) the panel is full screen (panel.ts layout()); cards.ts uses it too. */
export const FULL_BELOW = 640;

export const CSS =
  ":host{all:initial;font-family:inherit}" +
  ".panel{position:fixed;z-index:2147483001;display:flex;flex-direction:column;box-sizing:border-box;width:380px;height:600px;" +
  "max-height:calc(100vh - var(--off) - 80px);bottom:calc(var(--off) + 68px);right:20px;background:#fff;color:#111;border-radius:16px;" +
  "box-shadow:0 12px 40px rgba(0,0,0,.18),0 2px 8px rgba(0,0,0,.08);overflow:hidden;font:inherit;font-size:15px;line-height:21px;text-align:left;" +
  "letter-spacing:normal;text-transform:none;animation:in .2s ease-out}" +
  ".panel[hidden]{display:none}" +
  ":where(.panel) *{box-sizing:border-box;font:inherit;color:inherit;margin:0}" +
  ".panel.left{right:auto;left:20px}" +
  ".panel.full{inset:0;width:100%;height:100vh;height:100dvh;max-height:none;border-radius:0}" +
  ".panel.inline{max-width:760px;margin:0 auto}" + // a wide window: keep the chat readable
  "@keyframes in{from{opacity:0;transform:translateY(12px)}}" +
  ".hd{display:flex;align-items:center;gap:10px;padding:12px 8px 12px 14px;background:var(--ac);color:var(--ac-fg);flex:none}" +
  ".who{flex:1;min-width:0;display:flex;flex-direction:column}" +
  ".hd .name{font-weight:600;font-size:16px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
  ".hd .sub{font-size:12px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
  ".av{position:relative;flex:none;width:36px;height:36px}" +
  ".avatar{display:block;width:36px;height:36px;border-radius:50%;object-fit:cover}" + // the initial inverts the accent: AA by construction
  ".avatar.initial{display:flex;align-items:center;justify-content:center;background:var(--ac-fg);color:var(--ac);font-weight:600;font-size:16px}" +
  ".dot{position:absolute;right:-1px;bottom:-1px;width:10px;height:10px;border-radius:50%;background:#22c55e;border:2px solid var(--ac)}" +
  ":where(.panel) button{cursor:pointer;border:0;background:none;padding:0;text-transform:none;letter-spacing:normal;min-height:0;width:auto}" +
  ".ib{display:flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:18px;color:inherit;flex:none}" +
  ".ib[hidden]{display:none}" +
  ".hd .ib:hover{background:rgba(127,127,127,.2)}" +
  ".panel :focus-visible{outline:2px solid #2563eb;outline-offset:2px}" +
  ".hd :focus-visible{outline-color:var(--ac-fg)}" +
  ".mwrap{position:relative}" +
  ".mlist{position:absolute;right:0;top:40px;z-index:2;min-width:168px;padding:4px;background:#fff;color:#111;border-radius:10px;border:1px solid #e5e5e5;box-shadow:0 6px 20px rgba(0,0,0,.16)}" +
  ".mlist[hidden]{display:none}" +
  ".mlist button{display:block;width:100%;padding:9px 12px;border-radius:6px;text-align:left;font-size:14px}" +
  ".mlist button:hover,.mlist button:focus{background:#f2f2f2}" +
  ".log{flex:1;overflow-y:auto;padding:16px 14px;display:flex;flex-direction:column;gap:10px;overscroll-behavior:contain;background:#fafafa}" +
  ".welcome{align-self:flex-start;max-width:88%;padding:9px 13px;border-radius:16px 16px 16px 4px;background:#fff;border:1px solid #ececec;color:#222;white-space:pre-wrap;overflow-wrap:anywhere}" +
  ".sugg{display:flex;flex-wrap:wrap;gap:8px}" +
  ".sugg button{padding:8px 13px;border:1px solid #8a8a8a;border-radius:18px;background:#fff;text-align:left;font-size:14px;line-height:19px;transition:border-color .15s,background .15s}" +
  ".sugg button:hover{border-color:#111;background:#f4f4f4}" +
  ".msg{max-width:88%;white-space:pre-wrap;overflow-wrap:anywhere}" +
  ".msg.user{align-self:flex-end;padding:9px 13px;border-radius:16px 16px 4px 16px;background:var(--ac);color:var(--ac-fg)}" +
  ".msg.bot{align-self:flex-start;display:flex;flex-direction:column;gap:8px;width:88%}" +
  ".msg.bot .txt{align-self:flex-start;padding:9px 13px;border-radius:16px 16px 16px 4px;background:#fff;border:1px solid #ececec}" +
  ".cut{font-size:13px;color:#666}" +
  ".cards{max-width:100%}" +
  ".typing{display:flex;gap:4px;padding:13px 14px;border-radius:16px 16px 16px 4px;background:#fff;border:1px solid #ececec;align-self:flex-start}" +
  ".typing span{width:6px;height:6px;border-radius:3px;background:#777;animation:b 1s infinite}" +
  ".typing span:nth-child(2){animation-delay:.15s}.typing span:nth-child(3){animation-delay:.3s}" +
  "@keyframes b{50%{opacity:.25}}" +
  ".err{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 12px;border-radius:10px;background:#fdecec;color:#8a1c1c;font-size:14px}" +
  ".err .retry{padding:4px 10px;border:1px solid currentColor;border-radius:12px}" +
  ".askcart-feedback{display:flex;gap:4px}" +
  ".askcart-feedback__btn{display:flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:16px;color:#666}" +
  ".askcart-feedback__btn:hover{background:#f1f1f1}" +
  ".askcart-feedback__btn[aria-pressed=true]{color:var(--ac-fg);background:var(--ac)}" +
  ".offline{padding:8px 14px;background:#fff4d6;color:#5c4400;font-size:14px;flex:none}" +
  ".offline[hidden]{display:none}" +
  ".ft{flex:none;border-top:1px solid #e5e5e5;padding:10px 12px 8px;background:#fff}" +
  ".row{display:flex;align-items:flex-end;gap:8px}" +
  "textarea{flex:1;resize:none;min-height:40px;max-height:120px;padding:9px 12px;border:1px solid #8a8a8a;border-radius:20px;background:#fff;color:#111;font-size:16px;line-height:20px}" +
  "textarea:focus{border-color:var(--ac);outline:none;box-shadow:0 0 0 2px var(--ac)}" +
  ".send{width:40px;height:40px;border-radius:20px;background:var(--ac);color:var(--ac-fg)}" +
  ".send:disabled{opacity:.4;cursor:default}" +
  ".count{font-size:12px;color:#666;text-align:right;padding-top:2px}" +
  ".count[hidden]{display:none}" +
  ".notice{font-size:12px;line-height:16px;color:#666;padding-top:6px}" +
  ".notice a{color:inherit;text-decoration:underline}" +
  ".sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}" +
  "@media (prefers-reduced-motion:reduce){.panel,.typing span{animation:none}.sugg button{transition:none}}";
