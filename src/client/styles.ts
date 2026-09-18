/** dsh-tidecost 面板与触发器样式（跟随 DSH 主题变量）。 */
export const styles = `
.dshb-trigger{
  display:flex;align-items:center;gap:5px;width:100%;
  padding:6px 8px;border:1px solid var(--theme-border,#333);border-radius:8px;
  background:transparent;color:var(--theme-text,#ddd);cursor:pointer;font-size:12px;
  white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
}
.dshb-trigger:hover{background:rgba(74,158,255,.08);border-color:var(--theme-accent,#4a9eff)}
.dshb-trigger .dshb-label{overflow:hidden;text-overflow:ellipsis;flex:1;text-align:left;min-width:0}
.dshb-trigger.rail{width:auto;min-width:34px;height:36px;justify-content:center;padding:0 4px;border-radius:10px}
.dshb-dot{width:8px;height:8px;border-radius:50%;flex:none}
.dshb-dot.ok{background:#2ecc71}
.dshb-dot.warn{background:#f1c40f}
.dshb-dot.danger{background:#e74c3c}

/* 峰谷价徽标 */
.dshb-chip{font-size:10px;line-height:1.4;padding:1px 5px;border-radius:8px;white-space:nowrap;flex:none}
.dshb-chip.peak{background:rgba(231,76,60,.15);color:#e67e22}
.dshb-chip.valley{background:rgba(46,204,113,.14);color:#2ecc71}

.dshb-panel{
  position:fixed;left:10px;bottom:58px;z-index:1200;width:min(400px,calc(100vw - 20px));
  max-height:min(72vh,720px);overflow:auto;
  background:var(--theme-panel-bg,#1c1c1e);border:1px solid var(--theme-border,#444);
  border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.45);
  color:var(--theme-text,#ddd);font-size:12px;line-height:1.5;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
}
.dshb-panel::-webkit-scrollbar{width:6px}
.dshb-panel::-webkit-scrollbar-thumb{background:var(--theme-border,#444);border-radius:3px}
.dshb-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--theme-border,#333);position:sticky;top:0;background:inherit;z-index:1}
.dshb-title{font-size:13px;font-weight:600;flex:1}
.dshb-close{background:none;border:none;color:var(--theme-text-secondary,#999);cursor:pointer;font-size:14px;line-height:1;flex:none}
.dshb-close:hover{color:var(--theme-text,#fff)}
.dshb-body{padding:10px 12px;display:grid;gap:10px}
.dshb-card{border:1px solid var(--theme-border,#333);border-radius:8px;padding:8px 10px}
.dshb-card h4{margin:0 0 6px;font-size:11px;color:var(--theme-text-secondary,#888);text-transform:uppercase;letter-spacing:.04em}
.dshb-balance-main{display:flex;align-items:baseline;gap:6px;font-size:20px;font-weight:700}
.dshb-muted{color:var(--theme-text-secondary,#888);font-size:11px}
.dshb-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:4px 10px;margin-top:6px;font-size:11px}
.dshb-grid .k{color:var(--theme-text-secondary,#888)}
.dshb-row{display:flex;gap:6px;align-items:center}
.dshb-btn{background:var(--theme-accent,#4a9eff);color:#fff;border:none;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:11px}
.dshb-btn.ghost{background:transparent;border:1px solid var(--theme-border,#555);color:var(--theme-text,#ccc)}
.dshb-btn:disabled{opacity:.5;cursor:not-allowed}
.dshb-error{color:#e74c3c;font-size:11px;white-space:pre-wrap}
.dshb-hint{color:var(--theme-text-secondary,#888);font-size:11px}

/* 峰谷时段卡 */
.dshb-tide-main{display:flex;align-items:baseline;gap:10px;margin-bottom:6px;flex-wrap:wrap}
.dshb-tide-badge{font-size:18px;font-weight:700}
.dshb-tide-badge.peak{color:#e67e22}
.dshb-tide-badge.valley{color:#2ecc71}
.dshb-sched{width:100%;border-collapse:collapse;font-size:11px;margin:2px 0 6px}
.dshb-sched td{padding:2px 8px;border-bottom:1px solid var(--theme-border,#2a2a2a)}
.dshb-sched tr.now{background:rgba(74,158,255,.12)}
.dshb-sched td.pk{color:#e67e22;font-weight:600;text-align:right}
.dshb-sched td.vl{color:#2ecc71;font-weight:600;text-align:right}

.dshb-steps{display:grid;gap:4px;max-height:180px;overflow:auto;font-size:11px}
.dshb-step{display:grid;grid-template-columns:54px 1fr auto;gap:6px;align-items:center;padding:4px 6px;border:1px solid var(--theme-border,#2a2a2a);border-radius:6px}
.dshb-step .m{color:var(--theme-text-secondary,#888);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;align-items:center;gap:4px;min-width:0}
.dshb-step .c{text-align:right;white-space:nowrap}
.dshb-tier{font-size:9px;line-height:1.3;padding:0 3px;border-radius:4px;flex:none}
.dshb-tier.peak{color:#e67e22;background:rgba(231,76,60,.12)}
.dshb-tier.valley{color:#2ecc71;background:rgba(46,204,113,.12)}
.dshb-tier.flat{color:#4a9eff;background:rgba(74,158,255,.14)}
.dshb-total{display:flex;justify-content:space-between;gap:8px;border-top:1px solid var(--theme-border,#333);padding-top:6px;margin-top:6px;font-weight:600}
.dshb-budget-form{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.dshb-budget-form label{display:grid;gap:2px;font-size:10px;color:var(--theme-text-secondary,#888)}
.dshb-budget-form input{background:var(--theme-input-bg,#111);color:var(--theme-text,#ddd);border:1px solid var(--theme-border,#444);border-radius:6px;padding:5px 7px;font-size:12px;font-family:inherit}
.dshb-bar{height:6px;background:var(--theme-border,#333);border-radius:3px;overflow:hidden;margin-top:6px}
.dshb-bar > i{display:block;height:100%;background:var(--theme-accent,#4a9eff)}
.dshb-bar.danger > i{background:#e74c3c}
.dshb-bar.warn > i{background:#f1c40f}
.dshb-alerts{display:grid;gap:4px}
.dshb-alert{border-radius:6px;padding:5px 8px;font-size:11px;display:flex;align-items:center;gap:6px}
.dshb-alert.warn{background:rgba(241,196,15,.12);border:1px solid rgba(241,196,15,.35);color:#f1c40f}
.dshb-alert.danger{background:rgba(231,76,60,.12);border:1px solid rgba(231,76,60,.4);color:#e74c3c}
.dshb-alert.ok{background:rgba(46,204,113,.12);border:1px solid rgba(46,204,113,.35);color:#2ecc71}
.dshb-notice-text{flex:1}

/* 峰价·每日首次对话前确认弹窗 */
.dshb-mask{position:fixed;inset:0;z-index:1500;background:rgba(0,0,0,.55);
  display:flex;align-items:center;justify-content:center;padding:20px}
.dshb-modal{width:min(400px,100%);background:var(--theme-panel-bg,#1c1c1e);
  border:1px solid var(--theme-border,#444);border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.5);
  color:var(--theme-text,#ddd);overflow:hidden;font-family:inherit}
.dshb-modal-head{display:flex;align-items:center;gap:8px;padding:12px 14px;
  border-bottom:1px solid var(--theme-border,#333)}
.dshb-modal-body{padding:14px;font-size:12.5px;line-height:1.7}
.dshb-modal-body p{margin:0 0 8px}
.dshb-pk{color:#e67e22}
.dshb-modal-actions{display:flex;flex-wrap:wrap;gap:8px;padding:12px 14px;
  border-top:1px solid var(--theme-border,#333)}
.dshb-switch{display:inline-flex;align-items:center;gap:4px;color:var(--theme-text-secondary,#888);
  font-size:11px;cursor:pointer;margin-left:auto}
.dshb-switch input{cursor:pointer}
`
