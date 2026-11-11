/* しんちょくノート — タスクの期限・進捗とルーティンを管理する Web アプリ
 * データは端末内（localStorage）に保存。通知は iPhone 標準のカレンダーに任せる。 */
(() => {
  "use strict";

  const STORE_KEY = "shinchoku-note-v1";
  const WD = ["日", "月", "火", "水", "木", "金", "土"];
  const ICS_DAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
  const REMIND_OPTS = [
    [-1, "通知しない"],
    [0, "期限の時刻"],
    [10, "期限の時刻＋10分前"],
    [30, "期限の時刻＋30分前"],
    [60, "期限の時刻＋1時間前"],
    [180, "期限の時刻＋3時間前"],
    [1440, "期限の時刻＋1日前"],
  ];

  /* ---------- 状態と保存 ---------- */
  let state = load();
  let tab = "today";
  let taskFilter = "open";

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        return { tasks: d.tasks || [], routines: d.routines || [] };
      }
    } catch (e) { /* 壊れていたら空から */ }
    return { tasks: [], routines: [] };
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
    catch (e) { toast("保存できませんでした（プライベートブラウズ中かも）"); }
  }
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  /* ---------- 日付ユーティリティ ---------- */
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const todayStr = () => ymd(new Date());
  const parseLocal = (s) => (s ? new Date(s) : null); // "YYYY-MM-DDTHH:MM" はローカル時刻として解釈される
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

  function fmtDue(d) {
    const now = new Date();
    const t0 = startOfDay(now);
    const diffDay = Math.round((startOfDay(d) - t0) / 86400000);
    let day;
    if (diffDay === 0) day = "今日";
    else if (diffDay === 1) day = "明日";
    else if (diffDay === -1) day = "昨日";
    else day = `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`;
    if (d.getFullYear() !== now.getFullYear() && Math.abs(diffDay) > 1) day = `${d.getFullYear()}/` + day;
    return `${day} ${hm(d)}`;
  }
  function remaining(d) {
    const ms = d - Date.now();
    const a = Math.abs(ms);
    const min = Math.floor(a / 60000), h = Math.floor(a / 3600000), day = Math.floor(a / 86400000);
    const span = day >= 1 ? `${day}日` : h >= 1 ? `${h}時間` : `${Math.max(min, 1)}分`;
    if (ms < 0) return { text: `${span}超過`, cls: "danger" };
    if (ms < 86400000) return { text: `あと${span}`, cls: "warn" };
    return { text: `あと${span}`, cls: "" };
  }

  /* ---------- ルーティン ---------- */
  const isScheduled = (r, d) => r.days.includes(d.getDay());
  const isDoneOn = (r, ds) => (r.doneDates || []).includes(ds);
  function streak(r) {
    let d = new Date();
    if (!isDoneOn(r, ymd(d))) d = addDays(d, -1); // 今日まだなら昨日から数える
    let n = 0;
    for (let i = 0; i < 400; i++) {
      if (isScheduled(r, d)) {
        if (isDoneOn(r, ymd(d))) n++;
        else break;
      }
      d = addDays(d, -1);
    }
    return n;
  }
  function daysLabel(days) {
    const s = [...days].sort().join("");
    if (s === "0123456") return "毎日";
    if (s === "12345") return "平日";
    if (s === "06") return "週末";
    return [1, 2, 3, 4, 5, 6, 0].filter((x) => days.includes(x)).map((x) => WD[x]).join("・");
  }
  function nextOccurrence(r, from = new Date()) {
    const [H, M] = r.time.split(":").map(Number);
    for (let i = 0; i < 8; i++) {
      const d = addDays(from, i);
      d.setHours(H, M, 0, 0);
      if (isScheduled(r, d) && d > from) return d;
    }
    return null;
  }

  /* ---------- カレンダー(.ics) 生成 ---------- */
  const icsEsc = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  const icsLocal = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
  const icsUtc = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  function fold(line) {
    // 75オクテットごとに折り返す（UTF-8 の文字を途中で切らない）
    const enc = new TextEncoder();
    const out = [];
    let cur = "", bytes = 0, limit = 75;
    for (const ch of line) {
      const b = enc.encode(ch).length;
      if (bytes + b > limit) { out.push(cur); cur = " "; bytes = 1; limit = 75; }
      cur += ch; bytes += b;
    }
    out.push(cur);
    return out.join("\r\n");
  }
  function alarm(desc, minutesBefore) {
    return ["BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsEsc(desc)}`,
      `TRIGGER:${minutesBefore > 0 ? `-PT${minutesBefore}M` : "PT0M"}`, "END:VALARM"];
  }
  function taskEvent(t) {
    const due = parseLocal(t.due);
    const end = new Date(due.getTime() + 30 * 60000);
    const lines = ["BEGIN:VEVENT", `UID:task-${t.id}@shinchoku-note`, `DTSTAMP:${icsUtc(new Date())}`,
      `DTSTART:${icsLocal(due)}`, `DTEND:${icsLocal(end)}`,
      `SUMMARY:${icsEsc("【期限】" + t.title)}`];
    if (t.memo) lines.push(`DESCRIPTION:${icsEsc(t.memo)}`);
    if (t.remind >= 0) {
      lines.push(...alarm(`期限です：${t.title}`, 0));
      if (t.remind > 0) lines.push(...alarm(`もうすぐ期限：${t.title}`, t.remind));
    }
    lines.push("END:VEVENT");
    return lines;
  }
  function routineEvent(r) {
    const start = nextOccurrence(r, startOfDay(new Date())) || nextOccurrence(r);
    const end = new Date(start.getTime() + 15 * 60000);
    const rrule = r.days.length === 7 ? "RRULE:FREQ=DAILY"
      : `RRULE:FREQ=WEEKLY;BYDAY=${r.days.map((d) => ICS_DAY[d]).join(",")}`;
    return ["BEGIN:VEVENT", `UID:routine-${r.id}@shinchoku-note`, `DTSTAMP:${icsUtc(new Date())}`,
      `DTSTART:${icsLocal(start)}`, `DTEND:${icsLocal(end)}`, rrule,
      `SUMMARY:${icsEsc("🔁 " + r.title)}`, ...alarm(`ルーティンの時間です：${r.title}`, 0), "END:VEVENT"];
  }
  function buildIcs(eventLines) {
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ShinchokuNote//JA", "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH", ...eventLines, "END:VCALENDAR"];
    return lines.map(fold).join("\r\n") + "\r\n";
  }
  function openIcs(text, name) {
    const blob = new Blob([text], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    // iPhone では download 属性を付けないと「カレンダーに追加」画面が開く
    const ua = navigator.userAgent;
    const appleTouch = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && "ontouchend" in document);
    if (!appleTouch) a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  /* ---------- 画面描画 ---------- */
  const $ = (s, el = document) => el.querySelector(s);
  const main = $("#main");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const CHECK_SVG = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function render() {
    $("#screen-title").textContent = { today: "今日", tasks: "タスク", routines: "ルーティン" }[tab];
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    if (tab === "today") renderToday();
    else if (tab === "tasks") renderTasks();
    else renderRoutines();
  }

  function taskCard(t) {
    let meta = "";
    if (t.due) {
      const d = parseLocal(t.due);
      meta += `<span>📅 ${fmtDue(d)}</span>`;
      if (!t.done) { const r = remaining(d); meta += `<span class="badge ${r.cls}">${r.text}</span>`; }
    } else meta += `<span>期限なし</span>`;
    if (t.done) meta += `<span class="badge ok">完了</span>`;
    else if (t.calAdded && t.due && t.remind >= 0) meta += `<span class="badge cal">🔔 カレンダー通知</span>`;
    const bar = t.done ? "" :
      `<div class="bar-row"><div class="bar ${t.progress >= 100 ? "full" : ""}"><i style="width:${t.progress}%"></i></div><span>${t.progress}%</span></div>`;
    return `<div class="card ${t.done ? "done" : ""}" data-task="${t.id}">
      <button class="check ${t.done ? "on" : ""}" data-toggle-task="${t.id}" aria-label="完了にする">${CHECK_SVG}</button>
      <div class="body"><div class="title">${esc(t.title)}</div><div class="meta">${meta}</div>${bar}</div></div>`;
  }

  function routineCard(r, showCheck) {
    const ts = todayStr();
    const done = isDoneOn(r, ts);
    const s = streak(r);
    const meta = `<span>⏰ ${r.time}</span><span>${daysLabel(r.days)}</span>` +
      (s > 0 ? `<span class="badge ok">🔥 ${s}回連続</span>` : "") +
      (r.calAdded ? `<span class="badge cal">🔔 カレンダー通知</span>` : "");
    const check = showCheck
      ? `<button class="check ${done ? "on" : ""}" data-toggle-routine="${r.id}" aria-label="今日やった">${CHECK_SVG}</button>`
      : `<div class="check" style="border-style:dashed;cursor:default" aria-hidden="true"></div>`;
    return `<div class="card ${showCheck && done ? "done" : ""}" data-routine="${r.id}">${check}
      <div class="body"><div class="title">${esc(r.title)}</div><div class="meta">${meta}</div></div></div>`;
  }

  function renderToday() {
    const now = new Date();
    const ts = ymd(now);
    const todays = state.routines.filter((r) => isScheduled(r, now)).sort((a, b) => a.time.localeCompare(b.time));
    const rDone = todays.filter((r) => isDoneOn(r, ts)).length;
    const open = state.tasks.filter((t) => !t.done);
    const endToday = addDays(startOfDay(now), 1);
    const overdue = open.filter((t) => t.due && parseLocal(t.due) < now);
    const dueToday = open.filter((t) => t.due && parseLocal(t.due) >= now && parseLocal(t.due) < endToday);
    const soonLimit = addDays(startOfDay(now), 4);
    const soon = open.filter((t) => t.due && parseLocal(t.due) < soonLimit)
      .sort((a, b) => a.due.localeCompare(b.due));
    const doneToday = state.tasks.filter((t) => t.done && t.doneAt && ymd(new Date(t.doneAt)) === ts);

    // 今日の達成率 = (今日のルーティン完了 + 今日完了したタスク) / (今日のルーティン + 今日が期限 or 期限切れの未完了タスク + 今日完了したタスク)
    const total = todays.length + overdue.length + dueToday.length + doneToday.length;
    const got = rDone + doneToday.length;
    const pct = total ? Math.round((got / total) * 100) : 0;
    const C = 2 * Math.PI * 36;

    main.innerHTML = `
      <section class="summary">
        <div class="date">${now.getMonth() + 1}月${now.getDate()}日（${WD[now.getDay()]}）</div>
        <div class="ring-row">
          <div class="ring"><svg viewBox="0 0 84 84"><circle class="bg" cx="42" cy="42" r="36"/>
            <circle class="fg" cx="42" cy="42" r="36" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct / 100)}"/></svg>
            <div class="pct">${total ? pct + "%" : "—"}</div></div>
          <div class="ring-text">
            <span>今日の達成</span>
            <b>${total ? `${got} / ${total} 件` : "予定はありません"}</b>
            <span>ルーティン ${rDone}/${todays.length}・タスク完了 ${doneToday.length}</span>
          </div>
        </div>
        <div class="stats">
          <div class="stat ${overdue.length ? "danger" : ""}"><div class="n">${overdue.length}</div><div class="l">期限切れ</div></div>
          <div class="stat ${dueToday.length ? "warn" : ""}"><div class="n">${dueToday.length}</div><div class="l">今日が期限</div></div>
          <div class="stat"><div class="n">${open.length}</div><div class="l">未完了タスク</div></div>
        </div>
      </section>

      <div class="section-title">今日のルーティン <small>${rDone}/${todays.length}</small></div>
      <div class="list">${todays.length ? todays.map((r) => routineCard(r, true)).join("")
        : `<div class="empty">今日のルーティンはありません<br>「ルーティン」タブから登録できます</div>`}</div>

      <div class="section-title">期限が近いタスク <small>3日以内・期限切れ</small></div>
      <div class="list">${soon.length ? soon.map(taskCard).join("")
        : `<div class="empty">期限が近いタスクはありません 🎉</div>`}</div>`;
  }

  function renderTasks() {
    const all = state.tasks;
    const doneN = all.filter((t) => t.done).length;
    const avg = all.length ? Math.round(all.reduce((s, t) => s + (t.done ? 100 : t.progress), 0) / all.length) : 0;
    let list = all.filter((t) => (taskFilter === "open" ? !t.done : taskFilter === "done" ? t.done : true));
    list.sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      if (a.done) return (b.doneAt || 0) - (a.doneAt || 0);
      if (!a.due !== !b.due) return a.due ? -1 : 1;
      return (a.due || "").localeCompare(b.due || "") || a.createdAt - b.createdAt;
    });
    const chip = (k, label) => `<button class="chip ${taskFilter === k ? "on" : ""}" data-filter="${k}">${label}</button>`;
    main.innerHTML = `
      <section class="summary">
        <div class="ring-text"><span>全体の進捗</span><b>${doneN} / ${all.length} 件完了・平均 ${avg}%</b></div>
        <div class="bar ${avg >= 100 ? "full" : ""}" style="height:10px"><i style="width:${avg}%"></i></div>
      </section>
      <div class="section-title" style="margin-top:16px"><div class="chips">${chip("open", `未完了 ${all.length - doneN}`)}${chip("done", `完了 ${doneN}`)}${chip("all", "すべて")}</div></div>
      <div class="list">${list.length ? list.map(taskCard).join("")
        : `<div class="empty">${taskFilter === "done" ? "完了したタスクはまだありません" : "タスクはありません<br>右下の ＋ から追加しましょう"}</div>`}</div>`;
  }

  function renderRoutines() {
    const now = new Date();
    const list = [...state.routines].sort((a, b) => a.time.localeCompare(b.time));
    main.innerHTML = `
      <p class="note" style="margin:4px 4px 12px">決まった曜日・時刻にくり返す習慣です。今日が対象日のものはチェックできます。</p>
      <div class="list">${list.length ? list.map((r) => routineCard(r, isScheduled(r, now))).join("")
        : `<div class="empty">ルーティンはまだありません<br>右下の ＋ から追加しましょう<br><small>例：朝の筋トレ・日記・薬を飲む</small></div>`}</div>`;
  }

  /* ---------- 編集シート ---------- */
  const sheet = $("#sheet");
  const form = $("#sheet-form");
  function openSheet(html, bind) {
    form.innerHTML = `<div class="grab"></div>${html}`;
    bind && bind(form);
    sheet.showModal();
  }
  function closeSheet() { sheet.close(); }
  sheet.addEventListener("click", (e) => { if (e.target === sheet) closeSheet(); });

  function taskSheet(t) {
    const isNew = !t;
    t = t || { id: uid(), title: "", memo: "", due: "", remind: 0, progress: 0, done: false, createdAt: Date.now(), calAdded: false };
    const dueD = parseLocal(t.due);
    const opts = REMIND_OPTS.map(([v, l]) => `<option value="${v}" ${t.remind === v ? "selected" : ""}>${l}</option>`).join("");
    openSheet(`
      <h2>${isNew ? "タスクを追加" : "タスクを編集"}</h2>
      <div class="field"><label for="f-title">やること</label>
        <input type="text" id="f-title" value="${esc(t.title)}" placeholder="例：レポートを提出する" autocomplete="off" required></div>
      <div class="field"><span class="label">期限（いつまでに完了）</span>
        <div class="row2"><input type="date" id="f-date" value="${dueD ? ymd(dueD) : ""}"><input type="time" id="f-time" value="${dueD ? hm(dueD) : ""}"></div>
        <div class="quick">
          <button type="button" class="chip" data-q="0">今日</button><button type="button" class="chip" data-q="1">明日</button>
          <button type="button" class="chip" data-q="7">1週間後</button><button type="button" class="chip" data-q="x">期限なし</button>
        </div></div>
      <div class="field"><label for="f-remind">通知</label><select id="f-remind">${opts}</select></div>
      <div class="field"><label for="f-progress">進捗 <b id="f-pv">${t.progress}%</b></label>
        <input type="range" id="f-progress" min="0" max="100" step="5" value="${t.progress}"></div>
      <div class="field"><label for="f-memo">メモ</label><textarea id="f-memo" placeholder="任意">${esc(t.memo)}</textarea></div>
      <div class="actions">
        ${isNew ? "" : `<button type="button" class="btn danger" id="f-del">削除</button>`}
        <button type="button" class="btn" id="f-cancel">キャンセル</button>
        <button type="submit" class="btn primary" id="f-save">保存</button>
      </div>
      <div id="f-calwrap"></div>`,
    (f) => {
      const date = $("#f-date", f), time = $("#f-time", f);
      $("#f-progress", f).oninput = (e) => { $("#f-pv", f).textContent = e.target.value + "%"; };
      f.querySelectorAll("[data-q]").forEach((b) => b.onclick = () => {
        const q = b.dataset.q;
        if (q === "x") { date.value = ""; time.value = ""; return; }
        date.value = ymd(addDays(new Date(), Number(q)));
        if (!time.value) time.value = "18:00";
      });
      date.onchange = () => { if (date.value && !time.value) time.value = "18:00"; };
      $("#f-cancel", f).onclick = closeSheet;
      if (!isNew) $("#f-del", f).onclick = () => {
        if (!confirm(`「${t.title}」を削除しますか？` + (t.calAdded ? "\n※カレンダーに追加した予定は、カレンダーアプリから削除してください。" : ""))) return;
        state.tasks = state.tasks.filter((x) => x.id !== t.id); save(); closeSheet(); render();
      };
      f.onsubmit = (e) => {
        e.preventDefault();
        const title = $("#f-title", f).value.trim();
        if (!title) { $("#f-title", f).focus(); return; }
        const newDue = date.value ? `${date.value}T${time.value || "18:00"}` : "";
        const remind = Number($("#f-remind", f).value);
        const changedSchedule = newDue !== t.due || remind !== t.remind || title !== t.title;
        Object.assign(t, { title, memo: $("#f-memo", f).value.trim(), due: newDue, remind, progress: Number($("#f-progress", f).value) });
        if (t.progress >= 100 && !t.done) { t.done = true; t.doneAt = Date.now(); }
        if (changedSchedule && !isNew) t.calAdded = false;
        if (isNew) state.tasks.push(t);
        save(); render();
        // 期限＋通知ありなら、続けてカレンダー追加を案内
        if (t.due && t.remind >= 0 && !t.done && !t.calAdded && parseLocal(t.due) > new Date()) {
          calPrompt(`「${t.title}」の通知をカレンダーに追加`, () => {
            openIcs(buildIcs(taskEvent(t)), `task-${t.id}.ics`);
            t.calAdded = true; save(); render();
          }, changedSchedule && !isNew);
        } else closeSheet();
      };
      setTimeout(() => { if (isNew) $("#f-title", f).focus(); }, 50);
    });
  }

  function routineSheet(r) {
    const isNew = !r;
    r = r || { id: uid(), title: "", time: "07:00", days: [0, 1, 2, 3, 4, 5, 6], doneDates: [], calAdded: false };
    let days = [...r.days];
    const order = [1, 2, 3, 4, 5, 6, 0];
    openSheet(`
      <h2>${isNew ? "ルーティンを追加" : "ルーティンを編集"}</h2>
      <div class="field"><label for="r-title">内容</label>
        <input type="text" id="r-title" value="${esc(r.title)}" placeholder="例：朝のストレッチ" autocomplete="off" required></div>
      <div class="field"><label for="r-time">時刻（この時刻に通知）</label><input type="time" id="r-time" value="${r.time}" required></div>
      <div class="field"><span class="label">くり返す曜日</span>
        <div class="days">${order.map((d) => `<button type="button" class="day ${d === 0 ? "sun" : d === 6 ? "sat" : ""}" data-d="${d}">${WD[d]}</button>`).join("")}</div>
        <div class="quick"><button type="button" class="chip" data-p="all">毎日</button><button type="button" class="chip" data-p="wd">平日</button><button type="button" class="chip" data-p="we">週末</button></div></div>
      <div class="actions">
        ${isNew ? "" : `<button type="button" class="btn danger" id="r-del">削除</button>`}
        <button type="button" class="btn" id="r-cancel">キャンセル</button>
        <button type="submit" class="btn primary">保存</button>
      </div>`,
    (f) => {
      const paint = () => f.querySelectorAll(".day").forEach((b) => b.classList.toggle("on", days.includes(Number(b.dataset.d))));
      paint();
      f.querySelectorAll(".day").forEach((b) => b.onclick = () => {
        const d = Number(b.dataset.d);
        days = days.includes(d) ? days.filter((x) => x !== d) : [...days, d];
        paint();
      });
      f.querySelectorAll("[data-p]").forEach((b) => b.onclick = () => {
        days = { all: [0, 1, 2, 3, 4, 5, 6], wd: [1, 2, 3, 4, 5], we: [0, 6] }[b.dataset.p]; paint();
      });
      $("#r-cancel", f).onclick = closeSheet;
      if (!isNew) $("#r-del", f).onclick = () => {
        if (!confirm(`「${r.title}」を削除しますか？` + (r.calAdded ? "\n※カレンダーの予定（くり返し）は、カレンダーアプリで「今後のすべてのイベントを削除」してください。" : ""))) return;
        state.routines = state.routines.filter((x) => x.id !== r.id); save(); closeSheet(); render();
      };
      f.onsubmit = (e) => {
        e.preventDefault();
        const title = $("#r-title", f).value.trim();
        if (!title) { $("#r-title", f).focus(); return; }
        if (!days.length) { toast("曜日を1つ以上選んでください"); return; }
        const time = $("#r-time", f).value || "07:00";
        const changed = title !== r.title || time !== r.time || [...days].sort().join() !== [...r.days].sort().join();
        Object.assign(r, { title, time, days: days.sort() });
        if (changed && !isNew) r.calAdded = false;
        if (isNew) state.routines.push(r);
        save(); render();
        if (!r.calAdded) {
          calPrompt(`「${r.title}」の通知をカレンダーに追加`, () => {
            openIcs(buildIcs(routineEvent(r)), `routine-${r.id}.ics`);
            r.calAdded = true; save(); render();
          }, changed && !isNew);
        } else closeSheet();
      };
      setTimeout(() => { if (isNew) $("#r-title", f).focus(); }, 50);
    });
  }

  function calPrompt(label, onAdd, wasChanged) {
    form.innerHTML = `<div class="grab"></div>
      <h2>🔔 通知を設定しますか？</h2>
      <p class="note" style="font-size:14px;color:var(--text)">iPhone の「カレンダー」に予定として追加すると、指定した時刻にカレンダーから通知が届きます。</p>
      ${wasChanged ? `<p class="note">※内容を変更したので、カレンダーにある古い予定は手動で削除してください。</p>` : ""}
      <p class="note">次の画面で右上の「追加」→「完了」をタップしてください。</p>
      <div class="actions"><button type="button" class="btn" id="c-skip">あとで</button>
        <button type="button" class="btn primary" id="c-add">${label.length > 20 ? "カレンダーに追加" : label}</button></div>`;
    $("#c-skip", form).onclick = closeSheet;
    $("#c-add", form).onclick = () => { closeSheet(); onAdd(); };
  }

  function menuSheet() {
    const pendingTasks = state.tasks.filter((t) => !t.done && t.due && t.remind >= 0 && !t.calAdded && parseLocal(t.due) > new Date());
    const pendingRoutines = state.routines.filter((r) => !r.calAdded);
    const n = pendingTasks.length + pendingRoutines.length;
    openSheet(`
      <h2>メニュー</h2>
      <div class="menu-list">
        <button type="button" class="btn cal" id="m-cal" ${n ? "" : "disabled"}>🔔 未登録の通知をまとめてカレンダーに追加（${n}件）</button>
        <button type="button" class="btn" id="m-export">📤 バックアップを書き出す</button>
        <button type="button" class="btn" id="m-import">📥 バックアップから復元</button>
        <button type="button" class="btn" id="m-clear">🧹 完了したタスクを整理</button>
        <input type="file" id="m-file" accept="application/json,.json" hidden>
      </div>
      <p class="note">データはこの iPhone の中だけに保存されます。機種変更の前などにバックアップを書き出しておくと安心です。</p>
      <div class="actions"><button type="button" class="btn" id="m-close">閉じる</button></div>`,
    (f) => {
      $("#m-close", f).onclick = closeSheet;
      $("#m-cal", f).onclick = () => {
        const ev = [...pendingTasks.flatMap(taskEvent), ...pendingRoutines.flatMap(routineEvent)];
        openIcs(buildIcs(ev), "shinchoku-all.ics");
        pendingTasks.forEach((t) => (t.calAdded = true));
        pendingRoutines.forEach((r) => (r.calAdded = true));
        save(); closeSheet(); render();
      };
      $("#m-export", f).onclick = async () => {
        const json = JSON.stringify({ app: "shinchoku-note", version: 1, exportedAt: new Date().toISOString(), ...state }, null, 2);
        const file = new File([json], `shinchoku-backup-${todayStr()}.json`, { type: "application/json" });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          try { await navigator.share({ files: [file], title: "しんちょくノート バックアップ" }); return; } catch (e) { if (e.name === "AbortError") return; }
        }
        const a = document.createElement("a");
        a.href = URL.createObjectURL(file); a.download = file.name; a.click();
      };
      $("#m-import", f).onclick = () => $("#m-file", f).click();
      $("#m-file", f).onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
          const d = JSON.parse(await file.text());
          if (!Array.isArray(d.tasks) || !Array.isArray(d.routines)) throw new Error("bad");
          if (!confirm(`タスク${d.tasks.length}件・ルーティン${d.routines.length}件で上書きします。よろしいですか？`)) return;
          state = { tasks: d.tasks, routines: d.routines }; save(); closeSheet(); render(); toast("復元しました");
        } catch (err) { toast("バックアップファイルを読み込めませんでした"); }
      };
      $("#m-clear", f).onclick = () => {
        const n2 = state.tasks.filter((t) => t.done).length;
        if (!n2) { toast("完了したタスクはありません"); return; }
        if (!confirm(`完了したタスク${n2}件を削除しますか？`)) return;
        state.tasks = state.tasks.filter((t) => !t.done); save(); closeSheet(); render(); toast(`${n2}件を整理しました`);
      };
    });
  }

  /* ---------- 操作 ---------- */
  let toastTimer;
  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg; el.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
  }

  main.addEventListener("click", (e) => {
    const tt = e.target.closest("[data-toggle-task]");
    if (tt) {
      const t = state.tasks.find((x) => x.id === tt.dataset.toggleTask);
      t.done = !t.done;
      t.doneAt = t.done ? Date.now() : 0;
      if (t.done) { t.progress = 100; toast(t.calAdded ? "完了！（カレンダーの通知は必要なら削除してください）" : "完了！おつかれさま 🎉"); }
      else if (t.progress >= 100) t.progress = 90;
      save(); render(); return;
    }
    const tr = e.target.closest("[data-toggle-routine]");
    if (tr) {
      const r = state.routines.find((x) => x.id === tr.dataset.toggleRoutine);
      const ts = todayStr();
      r.doneDates = r.doneDates || [];
      if (r.doneDates.includes(ts)) r.doneDates = r.doneDates.filter((d) => d !== ts);
      else { r.doneDates.push(ts); r.doneDates = r.doneDates.sort().slice(-400); const s = streak(r); toast(s > 1 ? `🔥 ${s}回連続！` : "できた！"); }
      save(); render(); return;
    }
    const f = e.target.closest("[data-filter]");
    if (f) { taskFilter = f.dataset.filter; render(); return; }
    const tc = e.target.closest("[data-task]");
    if (tc) { taskSheet(state.tasks.find((x) => x.id === tc.dataset.task)); return; }
    const rc = e.target.closest("[data-routine]");
    if (rc) { routineSheet(state.routines.find((x) => x.id === rc.dataset.routine)); }
  });

  document.querySelectorAll(".tabs button").forEach((b) => b.onclick = () => { tab = b.dataset.tab; render(); window.scrollTo(0, 0); });
  $("#fab").onclick = () => (tab === "routines" ? routineSheet() : taskSheet());
  $("#menu-btn").onclick = menuSheet;

  // ホーム画面に追加していない iPhone の Safari ではヒントを出す
  const standalone = window.navigator.standalone || window.matchMedia("(display-mode: standalone)").matches;
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  let hintClosed = false;
  try { hintClosed = localStorage.getItem("shinchoku-hint-closed") === "1"; } catch (e) { /* noop */ }
  if (isIOS && !standalone && !hintClosed) $("#install-hint").hidden = false;
  $("#hint-close").onclick = () => {
    $("#install-hint").hidden = true;
    try { localStorage.setItem("shinchoku-hint-closed", "1"); } catch (e) { /* noop */ }
  };

  // 残り時間などを定期的に更新（日付が変わったときも）
  setInterval(() => { if (!sheet.open) render(); }, 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && !sheet.open) render(); });

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

  render();
})();
