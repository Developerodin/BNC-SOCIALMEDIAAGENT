// Panel CSS (Task 30; the editorial restyle). Everything lives in the shadow root; px only (themes set html { font-size: 62.5% });
// the font is inherited (UD7). --ac / --ac-fg are set on .panel from the checked accent and textOn() (UD17). The accent is used
// for the send button, the monogram, links in cards and the input's focus ring; everything else is neutral on white.
// Input-like borders are #8a8a8a: 3.4:1 on white (WCAG 1.4.11). The textarea is 16px: iOS Safari zooms into smaller inputs.
/** UD4: below this viewport width (px) the panel is full screen (panel.ts layout()); cards.ts uses it too. */
export const FULL_BELOW = 640;

export const CSS =
  ":host{all:initial;font-family:inherit}" +
  ".panel{position:fixed;z-index:2147483001;display:flex;flex-direction:column;box-sizing:border-box;width:380px;height:600px;" +
  "max-height:calc(100vh - var(--off) - 80px);transition:width .2s ease,height .2s ease;bottom:calc(var(--off) + 68px);right:20px;background:#fff;color:#111;border-radius:16px;" +
  "box-shadow:0 12px 40px rgba(0,0,0,.18),0 2px 8px rgba(0,0,0,.08);overflow:hidden;font:inherit;font-size:15px;line-height:21px;text-align:left;" +
  "letter-spacing:normal;text-transform:none;animation:in .2s ease-out}" +
  ".panel[hidden]{display:none}" +
  ":where(.panel) *{box-sizing:border-box;font:inherit;color:inherit;margin:0}" +
  ".panel.left{right:auto;left:20px}" +
  ".panel.drawer{top:0;bottom:0;right:0;left:auto;width:420px;max-width:100vw;height:100vh;height:100dvh;max-height:none;border-radius:0;animation:sl .25s ease-out}" +
  ".panel.full{inset:0;width:100%;height:100vh;height:100dvh;max-height:none;border-radius:0}" +
  ".panel.wide{width:min(760px,92vw);height:min(88vh,900px)}" + // expanded: still anchored to the launcher's side
  ".panel.inline{max-width:760px;margin:0 auto}" + // a wide window: keep the chat readable
  "@keyframes in{from{opacity:0;transform:translateY(12px)}}@keyframes sl{from{transform:translateX(100%)}}" +
  ".hd{display:flex;flex-direction:column;align-items:center;gap:2px;padding:8px 8px 12px;background:#fff;color:#111;flex:none}" +
  ".bar{display:flex;align-items:center;width:100%;min-height:36px}" +
  ".actions{display:flex;align-items:center;gap:2px;margin-left:auto}" +
  ".hd .name{margin-top:6px;font-weight:600;font-size:17px;line-height:22px;text-align:center;overflow-wrap:anywhere}" +
  ".hd .sub{font-size:12px;line-height:16px;color:#666;text-align:center}" +
  ".av{display:block;width:56px;height:56px;margin-top:-8px}" +
  ".avatar{display:block;width:56px;height:56px;border-radius:50%;object-fit:cover}" +
  ".avatar.initial{display:flex;align-items:center;justify-content:center;background:#f4f4f4;border:1px solid #e5e5e5;color:var(--ac);font-weight:600;font-size:24px}" +
  ":where(.panel) button{cursor:pointer;border:0;background:none;padding:0;text-transform:none;letter-spacing:normal;min-height:0;width:auto}" +
  ".ib{display:flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:18px;color:inherit;flex:none;text-decoration:none;cursor:pointer}" +
  ".ib[hidden]{display:none}" +
  ".ib.cart{position:relative}" +
  ".cbadge{position:absolute;top:1px;right:0;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:var(--ac);color:var(--ac-fg);font-size:11px;line-height:16px;font-weight:600;text-align:center}" +
  ".cbadge[hidden]{display:none}" +
  ".hd .ib:hover{background:#f2f2f2}" +
  ".panel :focus-visible{outline:2px solid #2563eb;outline-offset:2px}" +
  ".mwrap{position:relative}" +
  ".mlist{position:absolute;right:0;top:40px;z-index:2;min-width:168px;padding:4px;background:#fff;color:#111;border-radius:10px;border:1px solid #e5e5e5;box-shadow:0 6px 20px rgba(0,0,0,.16)}" +
  ".mlist[hidden]{display:none}" +
  ".mlist button{display:block;width:100%;padding:9px 12px;border-radius:6px;text-align:left;font-size:14px}" +
  ".mlist button:hover,.mlist button:focus{background:#f2f2f2}" +
  ".viewing{display:flex;align-items:center;gap:12px;flex:none;margin:0 16px 8px;padding:8px;border:1px solid #e8e8e8;border-radius:12px}" +
  ".viewing[hidden]{display:none}" +
  ".viewing img{display:block;flex:none;width:48px;height:48px;border-radius:8px;object-fit:cover;background:#f2f2f2}" +
  ".vw-txt{display:flex;flex-direction:column;min-width:0}" +
  ".vw-label{font-size:12px;line-height:16px;color:#666}" +
  ".vw-title{font-size:14px;line-height:19px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
  ".vw-price{font-size:13px;line-height:18px;color:#444}" +
  ".log{flex:1;overflow-y:auto;padding:8px 16px 16px;display:flex;flex-direction:column;gap:18px;overscroll-behavior:contain;background:#fff}" +
  ".welcome{align-self:flex-start;max-width:100%;line-height:24px;color:#222;white-space:pre-wrap;overflow-wrap:anywhere}" +
  ".sugg{display:flex;flex-wrap:wrap;gap:8px}" +
  ".sugg button{padding:8px 14px;border:1px solid #8a8a8a;border-radius:20px;background:#fff;text-align:left;font-size:14px;line-height:19px;transition:border-color .15s,background .15s}" +
  ".sugg button:hover{border-color:#111;background:#f4f4f4}" +
  ".msg{max-width:100%;white-space:pre-wrap;overflow-wrap:anywhere}" +
  ".txt{line-height:24px}" +
  ".txt ul{margin:8px 0;padding-left:20px;white-space:normal}.txt li{margin:2px 0}.txt strong{font-weight:600}" +
  ".msg.user{align-self:flex-end;max-width:85%;padding:8px 16px;border:1px solid #cfcfcf;border-radius:20px;background:transparent}" +
  ".msg.bot{align-self:stretch;display:flex;flex-direction:column;gap:12px}" +
  ".cut{font-size:13px;color:#666}" +
  ".note{align-self:flex-start;max-width:100%;font-size:13px;line-height:18px;color:#555;overflow-wrap:anywhere}" +
  ".note a{color:inherit;text-decoration:underline}" +
  ".cards{max-width:100%}" +
  ".status{display:flex;align-items:center;gap:8px;padding:8px 0;align-self:flex-start;font-size:14px;line-height:20px;color:#666}" +
  ".status svg{flex:none;width:16px;height:16px}" +
  ".stx{background:linear-gradient(90deg,#666 0,#666 40%,#bbb 50%,#666 60%,#666 100%) 0 0/200% 100%;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;animation:sh 2s linear infinite}" +
  "@keyframes sh{from{background-position:200% 0}to{background-position:-200% 0}}" +
  ".err{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 12px;border-radius:10px;background:#fdecec;color:#8a1c1c;font-size:14px}" +
  ".err .retry{padding:4px 10px;border:1px solid currentColor;border-radius:12px}" +
  ".askcart-feedback{display:flex;gap:4px}" +
  ".askcart-feedback__btn{display:flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:16px;color:#666}" +
  ".askcart-feedback__btn:hover{background:#f1f1f1}" +
  ".askcart-feedback__btn[aria-pressed=true]{color:var(--ac-fg);background:var(--ac)}" +
  ".offline{padding:8px 16px;background:#fff4d6;color:#5c4400;font-size:14px;flex:none}" +
  ".offline[hidden]{display:none}" +
  ".ft{flex:none;padding:8px 16px 12px;background:#fff}" +
  ".row{display:flex;align-items:flex-end;gap:8px}" +
  "textarea{flex:1;resize:none;min-height:44px;max-height:120px;padding:11px 18px;border:1px solid #8a8a8a;border-radius:22px;background:#fff;color:#111;font-size:16px;line-height:20px}" +
  "textarea:focus{border-color:var(--ac);outline:none;box-shadow:0 0 0 2px var(--ac)}" +
  ".send{display:flex;align-items:center;justify-content:center;flex:none;width:44px;height:44px;border-radius:22px;background:var(--ac);color:var(--ac-fg)}" +
  ".send:disabled{opacity:.4;cursor:default}" +
  ".count{font-size:12px;color:#666;text-align:right;padding-top:2px}" +
  ".count[hidden]{display:none}" +
  ".notice{font-size:12px;line-height:16px;color:#666;padding-top:8px;text-align:center}" +
  ".notice a{color:inherit;text-decoration:underline}" +
  ".sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}" +
  "@media (prefers-reduced-motion:reduce){.panel{animation:none}.stx{animation:none;background:none;-webkit-text-fill-color:currentColor}.panel.drawer{animation:none}.panel{transition:none}.sugg button{transition:none}}";
