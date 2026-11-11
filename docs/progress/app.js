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
    [10080, "期限の時刻＋1週間前"],
  ];
  const LONG_COLORS = ["#4f6bed", "#e0772b", "#1f9d6b", "#b04fd6", "#d6384b", "#0f8fb3"];

  /* ---------- 状態と保存 ---------- */
  let state = load();
  let tab = "today";
  let taskFilter = "open";
  let calMonth = firstOfMonth(new Date());
  let calSelected = ymd(new Date());

  function load() {
    let d = { tasks: [], routines: [] };
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) d = JSON.parse(raw);
    } catch (e) { /* 壊れていたら空から */ }
    return migrate(d);
  }
  // 古い形式のデータを最新の形にそろえる
  function migrate(d) {
    const tasks = (d.tasks || []).map((t) => ({ kind: "normal", steps: [], start: "", ...t }));
    const routines = (d.routines || []).map((r) => ({ end: addMinutes(r.time || "07:00", 30), doneDates: [], ...r }));
    return { tasks, routines };
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
    catch (e) { toast("保存できませんでした（プライベートブラウズ中かも）"); }
  }
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  /* ---------- 日付ユーティリティ ---------- */
  function pad(n) { return String(n).padStart(2, "0"); }
  function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function firstOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
  const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const todayStr = () => ymd(new Date());
  const parseLocal = (s) => (s ? new Date(s) : null); // "YYYY-MM-DDTHH:MM" はローカル時刻
  const parseDay = (s) => (s ? new Date(`${s}T00:00`) : null);
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const mdw = (d) => `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`;
  function addMinutes(time, m) {
    const [H, M] = time.split(":").map(Number);
    const t = (((H * 60 + M + m) % 1440) + 1440) % 1440;
    return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
  }
  const toMin = (time) => { const [H, M] = time.split(":").map(Number); return H * 60 + M; };

  function fmtDue(d) {
    const now = new Date();
    const diffDay = Math.round((startOfDay(d) - startOfDay(now)) / 86400000);
    let day;
    if (diffDay === 0) day = "今日";
    else if (diffDay === 1) day = "明日";
    else if (diffDay === -1) day = "昨日";
    else day = mdw(d);
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

  /* ---------- タスク ---------- */
  const isLong = (t) => t.kind === "long";
  function progressOf(t) {
    if (t.done) return 100;
    if (isLong(t) && t.steps.length) return Math.round((t.steps.filter((s) => s.done).length / t.steps.length) * 100);
    return t.progress;
  }
  // 長期タスクの「予定どおりなら今ごろ何％か」と、それに対するペース
  function pace(t) {
    if (!isLong(t) || !t.start || !t.due || t.done) return null;
    const s = parseDay(t.start), e = parseLocal(t.due), now = new Date();
    if (now < s) return { expected: 0, label: "開始前", cls: "" };
    const expected = Math.min(100, Math.max(0, Math.round(((now - s) / Math.max(e - s, 1)) * 100)));
    const diff = progressOf(t) - expected;
    if (diff >= -5) return { expected, label: diff >= 15 ? "前倒し" : "順調", cls: "ok" };
    if (diff >= -20) return { expected, label: "やや遅れ", cls: "warn" };
    return { expected, label: "遅れ", cls: "danger" };
  }
  function longColor(t) {
    let h = 0;
    for (const c of t.id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return LONG_COLORS[h % LONG_COLORS.length];
  }
  // 長期タスクがその日に「期間中」か
  function longCovers(t, ds) {
    if (!isLong(t) || !t.due) return false;
    const s = t.start || t.due.slice(0, 10);
    return ds >= s && ds <= t.due.slice(0, 10);
  }

  /* ---------- ルーティン ---------- */
  const isScheduled = (r, d) => r.days.includes(d.getDay());
  const isDoneOn = (r, ds) => (r.doneDates || []).includes(ds);
  const timeRange = (r) => `${r.time}〜${r.end}`;
  function durationLabel(r) {
    let m = toMin(r.end) - toMin(r.time);
    if (m <= 0) m += 1440;
    return m >= 60 ? `${Math.floor(m / 60)}時間${m % 60 ? (m % 60) + "分" : ""}` : `${m}分`;
  }
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
      if (isScheduled(r, d) && d >= from) return d;
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
    let cur = "", bytes = 0;
    for (const ch of line) {
      const b = enc.encode(ch).length;
      if (bytes + b > 75) { out.push(cur); cur = " "; bytes = 1; }
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
      `SUMMARY:${icsEsc((isLong(t) ? "【長期・期限】" : "【期限】") + t.title)}`];
    const desc = [t.memo, ...(t.steps || []).map((s) => `・${s.title}`)].filter(Boolean).join("\n");
    if (desc) lines.push(`DESCRIPTION:${icsEsc(desc)}`);
    if (t.remind >= 0) {
      lines.push(...alarm(`期限です：${t.title}`, 0));
      if (t.remind > 0) lines.push(...alarm(`もうすぐ期限：${t.title}`, t.remind));
    }
    lines.push("END:VEVENT");
    return lines;
  }
  function routineEvent(r) {
    const start = nextOccurrence(r, startOfDay(new Date()));
    let mins = toMin(r.end) - toMin(r.time);
    if (mins <= 0) mins += 1440;
    const end = new Date(start.getTime() + mins * 60000);
    const rrule = r.days.length === 7 ? "RRULE:FREQ=DAILY"
      : `RRULE:FREQ=WEEKLY;BYDAY=${r.days.map((d) => ICS_DAY[d]).join(",")}`;
    return ["BEGIN:VEVENT", `UID:routine-${r.id}@shinchoku-note`, `DTSTAMP:${icsUtc(new Date())}`,
      `DTSTART:${icsLocal(start)}`, `DTEND:${icsLocal(end)}`, rrule,
      `SUMMARY:${icsEsc("🔁 " + r.title)}`, ...alarm(`ルーティンの時間です：${r.title}（〜${r.end}）`, 0), "END:VEVENT"];
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
  const TITLES = { today: "今日", tasks: "タスク", calendar: "カレンダー", routines: "ルーティン" };

  function render() {
    $("#screen-title").textContent = TITLES[tab];
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    ({ today: renderToday, tasks: renderTasks, calendar: renderCalendar, routines: renderRoutines })[tab]();
  }

  function progressBar(t) {
    const p = progressOf(t);
    const pc = pace(t);
    const marker = pc && pc.expected > 0 && pc.expected < 100
      ? `<b class="pace-mark" style="left:${pc.expected}%" title="予定ペース"></b>` : "";
    return `<div class="bar-row"><div class="bar ${p >= 100 ? "full" : ""}"><i style="width:${p}%"></i>${marker}</div><span>${p}%</span></div>`;
  }

  function taskCard(t) {
    const long = isLong(t);
    let meta = "";
    if (long) meta += `<span class="badge long" style="--c:${longColor(t)}">長期</span>`;
    if (long && t.start && t.due) meta += `<span>🗓 ${mdw(parseDay(t.start))}〜${mdw(parseLocal(t.due))}</span>`;
    else if (t.due) meta += `<span>📅 ${fmtDue(parseLocal(t.due))}</span>`;
    else meta += `<span>期限なし</span>`;
    if (t.due && !t.done) { const r = remaining(parseLocal(t.due)); meta += `<span class="badge ${r.cls}">${r.text}</span>`; }
    if (t.done) meta += `<span class="badge ok">完了</span>`;
    const pc = pace(t);
    if (pc) meta += `<span class="badge ${pc.cls}">${pc.label}</span>`;
    if (long && t.steps.length) meta += `<span>ステップ ${t.steps.filter((s) => s.done).length}/${t.steps.length}</span>`;
    if (!t.done && t.calAdded && t.due && t.remind >= 0) meta += `<span class="badge cal">🔔通知</span>`;
    let next = "";
    if (long && !t.done) {
      const s = t.steps.find((x) => !x.done);
      if (s) next = `<div class="next-step">次：${esc(s.title)}</div>`;
    }
    return `<div class="card ${t.done ? "done" : ""} ${long ? "long" : ""}" data-task="${t.id}" ${long ? `style="--c:${longColor(t)}"` : ""}>
      <button class="check ${t.done ? "on" : ""}" data-toggle-task="${t.id}" aria-label="完了にする">${CHECK_SVG}</button>
      <div class="body"><div class="title">${esc(t.title)}</div><div class="meta">${meta}</div>${t.done ? "" : progressBar(t)}${next}</div></div>`;
  }

  function routineCard(r, ds, checkable) {
    const done = isDoneOn(r, ds);
    const s = streak(r);
    const meta = `<span>⏰ ${timeRange(r)}</span><span>${daysLabel(r.days)}</span>` +
      (s > 0 ? `<span class="badge ok">🔥 ${s}回連続</span>` : "") +
      (r.calAdded ? `<span class="badge cal">🔔通知</span>` : "");
    const check = checkable
      ? `<button class="check ${done ? "on" : ""}" data-toggle-routine="${r.id}" data-date="${ds}" aria-label="やった">${CHECK_SVG}</button>`
      : `<div class="check ghost" aria-hidden="true"></div>`;
    return `<div class="card ${checkable && done ? "done" : ""}" data-routine="${r.id}">${check}
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
    const soon = open.filter((t) => t.due && parseLocal(t.due) < soonLimit).sort((a, b) => a.due.localeCompare(b.due));
    const longs = open.filter((t) => isLong(t) && !soon.includes(t) && (!t.start || t.start <= ts))
      .sort((a, b) => (a.due || "9").localeCompare(b.due || "9"));
    const doneToday = state.tasks.filter((t) => t.done && t.doneAt && ymd(new Date(t.doneAt)) === ts);

    const total = todays.length + overdue.length + dueToday.length + doneToday.length;
    const got = rDone + doneToday.length;
    const pct = total ? Math.round((got / total) * 100) : 0;
    const C = 2 * Math.PI * 36;
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const current = todays.find((r) => !isDoneOn(r, ts) && nowMin >= toMin(r.time) && nowMin < (toMin(r.end) > toMin(r.time) ? toMin(r.end) : 1440));

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
        ${current ? `<div class="now-banner">▶ いまは「${esc(current.title)}」の時間（〜${current.end}）</div>` : ""}
      </section>

      <div class="section-title">今日のルーティン <small>${rDone}/${todays.length}</small></div>
      <div class="list">${todays.length ? todays.map((r) => routineCard(r, ts, true)).join("")
        : `<div class="empty">今日のルーティンはありません<br>「ルーティン」タブから登録できます</div>`}</div>

      <div class="section-title">期限が近いタスク <small>3日以内・期限切れ</small></div>
      <div class="list">${soon.length ? soon.map(taskCard).join("")
        : `<div class="empty">期限が近いタスクはありません 🎉</div>`}</div>

      ${longs.length ? `<div class="section-title">進行中の長期タスク <small>${longs.length}件</small></div>
      <div class="list">${longs.map(taskCard).join("")}</div>` : ""}`;
  }

  function renderTasks() {
    const all = state.tasks;
    const doneN = all.filter((t) => t.done).length;
    const avg = all.length ? Math.round(all.reduce((s, t) => s + progressOf(t), 0) / all.length) : 0;
    const longN = all.filter((t) => isLong(t) && !t.done).length;
    let list = all.filter((t) => (taskFilter === "open" ? !t.done : taskFilter === "done" ? t.done
      : taskFilter === "long" ? isLong(t) && !t.done : true));
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
      <div class="section-title" style="margin-top:16px"><div class="chips">${chip("open", `未完了 ${all.length - doneN}`)}${chip("long", `長期 ${longN}`)}${chip("done", `完了 ${doneN}`)}${chip("all", "すべて")}</div></div>
      <div class="list">${list.length ? list.map(taskCard).join("")
        : `<div class="empty">${taskFilter === "done" ? "完了したタスクはまだありません"
          : taskFilter === "long" ? "長期タスクはありません<br>＋ →「長期」で、開始日〜期限とステップを決めて登録できます"
          : "タスクはありません<br>右下の ＋ から追加しましょう"}</div>`}</div>`;
  }

  function renderRoutines() {
    const now = new Date();
    const ts = ymd(now);
    const list = [...state.routines].sort((a, b) => a.time.localeCompare(b.time));
    main.innerHTML = `
      <p class="note" style="margin:4px 4px 12px">決まった曜日・時間帯にくり返す習慣です。今日が対象日のものはチェックできます。</p>
      <div class="list">${list.length ? list.map((r) => routineCard(r, ts, isScheduled(r, now))).join("")
        : `<div class="empty">ルーティンはまだありません<br>右下の ＋ から追加しましょう<br><small>例：朝の筋トレ 7:00〜7:30・日記・薬を飲む</small></div>`}</div>`;
  }

  /* ---------- カレンダー画面 ---------- */
  function renderCalendar() {
    const y = calMonth.getFullYear(), m = calMonth.getMonth();
    const first = new Date(y, m, 1);
    const gridStart = addDays(first, -first.getDay());
    const weeks = Math.ceil((first.getDay() + new Date(y, m + 1, 0).getDate()) / 7);
    const ts = todayStr();
    const now = new Date();
    const longs = state.tasks.filter((t) => isLong(t) && t.due);

    let cells = "";
    for (let i = 0; i < weeks * 7; i++) {
      const d = addDays(gridStart, i);
      const ds = ymd(d);
      const dues = state.tasks.filter((t) => t.due && t.due.slice(0, 10) === ds);
      const dots = dues.slice(0, 3).map((t) => {
        const cls = t.done ? "done" : parseLocal(t.due) < now ? "over" : isLong(t) ? "long" : "";
        return `<i class="dot ${cls}" ${isLong(t) && !t.done ? `style="background:${longColor(t)}"` : ""}></i>`;
      }).join("") + (dues.length > 3 ? `<i class="more">+</i>` : "");
      const bars = longs.filter((t) => longCovers(t, ds)).slice(0, 3).map((t) => {
        const s = (t.start || t.due.slice(0, 10)) === ds || d.getDay() === 0;
        const e = t.due.slice(0, 10) === ds || d.getDay() === 6;
        return `<i class="span ${s ? "s" : ""} ${e ? "e" : ""} ${t.done ? "done" : ""}" style="background:${longColor(t)}"></i>`;
      }).join("");
      const sched = state.routines.filter((r) => isScheduled(r, d));
      const allDone = sched.length && ds <= ts && sched.every((r) => isDoneOn(r, ds));
      const cls = [d.getMonth() !== m ? "out" : "", ds === ts ? "today" : "", ds === calSelected ? "sel" : "",
        d.getDay() === 0 ? "sun" : d.getDay() === 6 ? "sat" : ""].join(" ");
      cells += `<button class="cal-cell ${cls}" data-day="${ds}">
        <span class="num">${d.getDate()}${allDone ? '<em class="rdone">✓</em>' : ""}</span>
        <span class="spans">${bars}</span><span class="dots">${dots}</span></button>`;
    }

    main.innerHTML = `
      <section class="cal">
        <div class="cal-head">
          <button class="icon-btn sm" data-cal-move="-1" aria-label="前の月">‹</button>
          <b>${y}年${m + 1}月</b>
          <button class="icon-btn sm" data-cal-move="1" aria-label="次の月">›</button>
        </div>
        <div class="cal-grid wd">${WD.map((w, i) => `<span class="${i === 0 ? "sun" : i === 6 ? "sat" : ""}">${w}</span>`).join("")}</div>
        <div class="cal-grid">${cells}</div>
        <div class="cal-legend"><span><i class="dot"></i>期限</span><span><i class="dot over"></i>期限切れ</span><span><i class="span s e" style="background:var(--primary)"></i>長期タスクの期間</span><span><em class="rdone">✓</em>ルーティン全部できた</span></div>
        ${calMonth.getTime() !== firstOfMonth(now).getTime() ? `<button class="text-btn" data-cal-today style="justify-self:center">今日に戻る</button>` : ""}
      </section>
      ${dayAgenda(calSelected)}`;
  }

  function dayAgenda(ds) {
    const d = parseDay(ds);
    const ts = todayStr();
    const routines = state.routines.filter((r) => isScheduled(r, d)).sort((a, b) => a.time.localeCompare(b.time));
    const dues = state.tasks.filter((t) => t.due && t.due.slice(0, 10) === ds).sort((a, b) => a.due.localeCompare(b.due));
    const ongoing = state.tasks.filter((t) => longCovers(t, ds) && !dues.includes(t));
    const empty = !routines.length && !dues.length && !ongoing.length;
    return `
      <div class="section-title">${d.getMonth() + 1}月${d.getDate()}日（${WD[d.getDay()]}）${ds === ts ? " ・今日" : ""}
        <button class="text-btn" data-add-on="${ds}">＋ この日にタスク</button></div>
      ${empty ? `<div class="empty">予定はありません</div>` : ""}
      ${routines.length ? `<div class="sub-title">ルーティン</div><div class="list">${routines.map((r) => routineCard(r, ds, ds <= ts)).join("")}</div>` : ""}
      ${dues.length ? `<div class="sub-title">この日が期限</div><div class="list">${dues.map(taskCard).join("")}</div>` : ""}
      ${ongoing.length ? `<div class="sub-title">期間中の長期タスク</div><div class="list">${ongoing.map(taskCard).join("")}</div>` : ""}`;
  }

  /* ---------- 編集シート ---------- */
  const sheet = $("#sheet");
  const form = $("#sheet-form");
  function openSheet(html, bind) {
    form.innerHTML = `<div class="grab"></div>${html}`;
    form.onsubmit = null;
    bind && bind(form);
    if (!sheet.open) sheet.showModal();
    sheet.scrollTop = 0;
  }
  function closeSheet() { sheet.close(); }
  sheet.addEventListener("click", (e) => { if (e.target === sheet) closeSheet(); });

  function taskSheet(t, presetDate) {
    const isNew = !t;
    t = t || { id: uid(), kind: "normal", title: "", memo: "", start: "", due: presetDate ? `${presetDate}T18:00` : "",
      remind: 0, progress: 0, steps: [], done: false, createdAt: Date.now(), calAdded: false };
    let kind = t.kind;
    let steps = t.steps.map((s) => ({ ...s }));
    const dueD = parseLocal(t.due);
    const opts = REMIND_OPTS.map(([v, l]) => `<option value="${v}" ${t.remind === v ? "selected" : ""}>${l}</option>`).join("");
    openSheet(`
      <h2>${isNew ? "タスクを追加" : "タスクを編集"}</h2>
      <div class="seg" role="tablist">
        <button type="button" data-kind="normal">ふつう</button>
        <button type="button" data-kind="long">長期（期間＋ステップ）</button>
      </div>
      <div class="field"><label for="f-title">やること</label>
        <input type="text" id="f-title" value="${esc(t.title)}" placeholder="例：レポートを提出する" autocomplete="off" required></div>
      <div class="field long-only"><label for="f-start">開始日</label><input type="date" id="f-start" value="${esc(t.start)}"></div>
      <div class="field"><span class="label">期限（いつまでに完了）</span>
        <div class="row2"><input type="date" id="f-date" value="${dueD ? ymd(dueD) : ""}"><input type="time" id="f-time" value="${dueD ? hm(dueD) : ""}"></div>
        <div class="quick normal-only">
          <button type="button" class="chip" data-q="0">今日</button><button type="button" class="chip" data-q="1">明日</button>
          <button type="button" class="chip" data-q="7">1週間後</button><button type="button" class="chip" data-q="x">期限なし</button>
        </div>
        <div class="quick long-only">
          <button type="button" class="chip" data-q="14">2週間後</button><button type="button" class="chip" data-q="30">1か月後</button>
          <button type="button" class="chip" data-q="90">3か月後</button><button type="button" class="chip" data-q="180">半年後</button>
        </div></div>
      <div class="field long-only"><span class="label">ステップ（チェックすると進捗が自動で上がります）</span>
        <div id="f-steps" class="steps"></div>
        <div class="step-add"><input type="text" id="f-step-new" placeholder="例：資料を集める" autocomplete="off"><button type="button" class="btn" id="f-step-btn">追加</button></div>
      </div>
      <div class="field" id="f-progress-field"><label for="f-progress">進捗 <b id="f-pv">${t.progress}%</b></label>
        <input type="range" id="f-progress" min="0" max="100" step="5" value="${t.progress}"></div>
      <div class="field"><label for="f-remind">通知</label><select id="f-remind">${opts}</select></div>
      <div class="field"><label for="f-memo">メモ</label><textarea id="f-memo" placeholder="任意">${esc(t.memo)}</textarea></div>
      <div class="actions">
        ${isNew ? "" : `<button type="button" class="btn danger" id="f-del">削除</button>`}
        <button type="button" class="btn" id="f-cancel">キャンセル</button>
        <button type="submit" class="btn primary" id="f-save">保存</button>
      </div>`,
    (f) => {
      const date = $("#f-date", f), time = $("#f-time", f), startI = $("#f-start", f);
      const paintKind = () => {
        f.querySelectorAll("[data-kind]").forEach((b) => b.classList.toggle("on", b.dataset.kind === kind));
        f.querySelectorAll(".long-only").forEach((el) => (el.hidden = kind !== "long"));
        f.querySelectorAll(".normal-only").forEach((el) => (el.hidden = kind === "long"));
        $("#f-progress-field", f).hidden = kind === "long" && steps.length > 0;
        $("#f-title", f).placeholder = kind === "long" ? "例：資格試験に合格する" : "例：レポートを提出する";
        if (kind === "long" && !startI.value) startI.value = todayStr();
      };
      const paintSteps = () => {
        $("#f-steps", f).innerHTML = steps.length ? steps.map((s, i) => `
          <div class="step ${s.done ? "done" : ""}">
            <button type="button" class="check sm ${s.done ? "on" : ""}" data-step-toggle="${i}" aria-label="完了">${CHECK_SVG}</button>
            <input type="text" value="${esc(s.title)}" data-step-edit="${i}" aria-label="ステップ名">
            <button type="button" class="step-del" data-step-del="${i}" aria-label="削除">✕</button>
          </div>`).join("") : `<p class="note">まだステップがありません。大きな目標を小さな段階に分けてみましょう。</p>`;
        $("#f-progress-field", f).hidden = kind === "long" && steps.length > 0;
      };
      paintKind(); paintSteps();
      f.querySelectorAll("[data-kind]").forEach((b) => b.onclick = () => { kind = b.dataset.kind; paintKind(); });
      const addStep = () => {
        const inp = $("#f-step-new", f);
        const v = inp.value.trim();
        if (!v) return;
        steps.push({ id: uid(), title: v, done: false });
        inp.value = ""; paintSteps(); inp.focus();
      };
      $("#f-step-btn", f).onclick = addStep;
      $("#f-step-new", f).onkeydown = (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); addStep(); } };
      $("#f-steps", f).addEventListener("click", (e) => {
        const tg = e.target.closest("[data-step-toggle]");
        if (tg) { const s = steps[Number(tg.dataset.stepToggle)]; s.done = !s.done; paintSteps(); return; }
        const dl = e.target.closest("[data-step-del]");
        if (dl) { steps.splice(Number(dl.dataset.stepDel), 1); paintSteps(); }
      });
      $("#f-steps", f).addEventListener("input", (e) => {
        const ed = e.target.closest("[data-step-edit]");
        if (ed) steps[Number(ed.dataset.stepEdit)].title = ed.value;
      });
      $("#f-progress", f).oninput = (e) => { $("#f-pv", f).textContent = e.target.value + "%"; };
      f.querySelectorAll("[data-q]").forEach((b) => b.onclick = () => {
        const q = b.dataset.q;
        if (q === "x") { date.value = ""; time.value = ""; return; }
        const base = kind === "long" && startI.value ? parseDay(startI.value) : new Date();
        date.value = ymd(addDays(base, Number(q)));
        if (!time.value) time.value = kind === "long" ? "23:59" : "18:00";
      });
      date.onchange = () => { if (date.value && !time.value) time.value = kind === "long" ? "23:59" : "18:00"; };
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
        if (kind === "long") {
          if (!newDue) { toast("長期タスクは期限を決めてください"); date.focus(); return; }
          if (startI.value && startI.value > date.value) { toast("開始日が期限より後になっています"); return; }
        }
        const pending = $("#f-step-new", f).value.trim();
        if (kind === "long" && pending) steps.push({ id: uid(), title: pending, done: false });
        const remind = Number($("#f-remind", f).value);
        const changedSchedule = newDue !== t.due || remind !== t.remind || title !== t.title;
        Object.assign(t, {
          kind, title, memo: $("#f-memo", f).value.trim(), due: newDue, remind,
          start: kind === "long" ? startI.value : "",
          steps: kind === "long" ? steps.filter((s) => s.title.trim()) : [],
          progress: Number($("#f-progress", f).value),
        });
        if (progressOf({ ...t, done: false }) >= 100 && !t.done) { t.done = true; t.doneAt = Date.now(); }
        if (changedSchedule && !isNew) t.calAdded = false;
        if (isNew) state.tasks.push(t);
        save(); render();
        if (t.due && t.remind >= 0 && !t.done && !t.calAdded && parseLocal(t.due) > new Date()) {
          calPrompt(() => {
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
    r = r || { id: uid(), title: "", time: "07:00", end: "07:30", days: [0, 1, 2, 3, 4, 5, 6], doneDates: [], calAdded: false };
    let days = [...r.days];
    const order = [1, 2, 3, 4, 5, 6, 0];
    openSheet(`
      <h2>${isNew ? "ルーティンを追加" : "ルーティンを編集"}</h2>
      <div class="field"><label for="r-title">内容</label>
        <input type="text" id="r-title" value="${esc(r.title)}" placeholder="例：朝のストレッチ" autocomplete="off" required></div>
      <div class="field"><span class="label">時間帯（開始の時刻に通知）</span>
        <div class="row2 time-range"><label class="mini">開始<input type="time" id="r-time" value="${r.time}" required></label>
          <label class="mini">終了<input type="time" id="r-end" value="${r.end}" required></label></div>
        <div class="quick"><button type="button" class="chip" data-len="15">15分</button><button type="button" class="chip" data-len="30">30分</button>
          <button type="button" class="chip" data-len="60">1時間</button><button type="button" class="chip" data-len="120">2時間</button></div>
        <p class="note" id="r-dur"></p></div>
      <div class="field"><span class="label">くり返す曜日</span>
        <div class="days">${order.map((d) => `<button type="button" class="day ${d === 0 ? "sun" : d === 6 ? "sat" : ""}" data-d="${d}">${WD[d]}</button>`).join("")}</div>
        <div class="quick"><button type="button" class="chip" data-p="all">毎日</button><button type="button" class="chip" data-p="wd">平日</button><button type="button" class="chip" data-p="we">週末</button></div></div>
      <div class="actions">
        ${isNew ? "" : `<button type="button" class="btn danger" id="r-del">削除</button>`}
        <button type="button" class="btn" id="r-cancel">キャンセル</button>
        <button type="submit" class="btn primary">保存</button>
      </div>`,
    (f) => {
      const tI = $("#r-time", f), eI = $("#r-end", f);
      let len = (toMin(r.end) - toMin(r.time) + 1440) % 1440 || 30;
      const showDur = () => {
        if (!tI.value || !eI.value) return;
        $("#r-dur", f).textContent = `${tI.value}〜${eI.value}（${durationLabel({ time: tI.value, end: eI.value })}）`
          + (toMin(eI.value) <= toMin(tI.value) ? " ・日をまたぎます" : "");
      };
      showDur();
      // 開始時刻を変えたら、長さを保ったまま終了時刻もずらす
      tI.onchange = () => { if (tI.value) eI.value = addMinutes(tI.value, len); showDur(); };
      eI.onchange = () => { if (tI.value && eI.value) len = (toMin(eI.value) - toMin(tI.value) + 1440) % 1440 || 1440; showDur(); };
      f.querySelectorAll("[data-len]").forEach((b) => b.onclick = () => {
        len = Number(b.dataset.len); eI.value = addMinutes(tI.value || "07:00", len); showDur();
      });
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
        const time = tI.value || "07:00";
        const end = eI.value || addMinutes(time, 30);
        if (end === time) { toast("終了時刻を開始時刻と別にしてください"); return; }
        const changed = title !== r.title || time !== r.time || end !== r.end || [...days].sort().join() !== [...r.days].sort().join();
        Object.assign(r, { title, time, end, days: days.sort() });
        if (changed && !isNew) r.calAdded = false;
        if (isNew) state.routines.push(r);
        save(); render();
        if (!r.calAdded) {
          calPrompt(() => {
            openIcs(buildIcs(routineEvent(r)), `routine-${r.id}.ics`);
            r.calAdded = true; save(); render();
          }, changed && !isNew);
        } else closeSheet();
      };
      setTimeout(() => { if (isNew) $("#r-title", f).focus(); }, 50);
    });
  }

  function calPrompt(onAdd, wasChanged) {
    form.onsubmit = (e) => e.preventDefault();
    form.innerHTML = `<div class="grab"></div>
      <h2>🔔 通知を設定しますか？</h2>
      <p class="note" style="font-size:14px;color:var(--text)">iPhone の「カレンダー」に予定として追加すると、指定した時刻にカレンダーから通知が届きます。</p>
      ${wasChanged ? `<p class="note">※内容を変更したので、カレンダーにある古い予定は手動で削除してください。</p>` : ""}
      <p class="note">次の画面で右上の「追加」→「完了」をタップしてください。</p>
      <div class="actions"><button type="button" class="btn" id="c-skip">あとで</button>
        <button type="button" class="btn primary" id="c-add">カレンダーに追加</button></div>`;
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
      f.onsubmit = (e) => e.preventDefault();
      $("#m-close", f).onclick = closeSheet;
      $("#m-cal", f).onclick = () => {
        const ev = [...pendingTasks.flatMap(taskEvent), ...pendingRoutines.flatMap(routineEvent)];
        openIcs(buildIcs(ev), "shinchoku-all.ics");
        pendingTasks.forEach((t) => (t.calAdded = true));
        pendingRoutines.forEach((r) => (r.calAdded = true));
        save(); closeSheet(); render();
      };
      $("#m-export", f).onclick = async () => {
        const json = JSON.stringify({ app: "shinchoku-note", version: 2, exportedAt: new Date().toISOString(), ...state }, null, 2);
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
          state = migrate(d); save(); closeSheet(); render(); toast("復元しました");
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
      if (t.done) { if (!isLong(t) || !t.steps.length) t.progress = 100; toast(t.calAdded ? "完了！（カレンダーの通知は必要なら削除してください）" : "完了！おつかれさま 🎉"); }
      else if (t.progress >= 100) t.progress = 90;
      save(); render(); return;
    }
    const tr = e.target.closest("[data-toggle-routine]");
    if (tr) {
      const r = state.routines.find((x) => x.id === tr.dataset.toggleRoutine);
      const ds = tr.dataset.date || todayStr();
      if (r.doneDates.includes(ds)) r.doneDates = r.doneDates.filter((d) => d !== ds);
      else { r.doneDates.push(ds); r.doneDates = r.doneDates.sort().slice(-400); const s = streak(r); toast(s > 1 ? `🔥 ${s}回連続！` : "できた！"); }
      save(); render(); return;
    }
    const f = e.target.closest("[data-filter]");
    if (f) { taskFilter = f.dataset.filter; render(); return; }
    const mv = e.target.closest("[data-cal-move]");
    if (mv) { calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + Number(mv.dataset.calMove), 1); render(); return; }
    if (e.target.closest("[data-cal-today]")) { calMonth = firstOfMonth(new Date()); calSelected = todayStr(); render(); return; }
    const day = e.target.closest("[data-day]");
    if (day) {
      calSelected = day.dataset.day;
      const d = parseDay(calSelected);
      if (d.getMonth() !== calMonth.getMonth()) calMonth = firstOfMonth(d);
      render(); return;
    }
    const ao = e.target.closest("[data-add-on]");
    if (ao) { taskSheet(null, ao.dataset.addOn); return; }
    const tc = e.target.closest("[data-task]");
    if (tc) { taskSheet(state.tasks.find((x) => x.id === tc.dataset.task)); return; }
    const rc = e.target.closest("[data-routine]");
    if (rc) { routineSheet(state.routines.find((x) => x.id === rc.dataset.routine)); }
  });

  // カレンダーは左右スワイプでも月を移動
  let touchX = null;
  main.addEventListener("touchstart", (e) => { if (tab === "calendar" && e.target.closest(".cal")) touchX = e.touches[0].clientX; }, { passive: true });
  main.addEventListener("touchend", (e) => {
    if (touchX === null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    touchX = null;
    if (Math.abs(dx) > 60) { calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + (dx < 0 ? 1 : -1), 1); render(); }
  }, { passive: true });

  document.querySelectorAll(".tabs button").forEach((b) => b.onclick = () => { tab = b.dataset.tab; render(); window.scrollTo(0, 0); });
  $("#fab").onclick = () => (tab === "routines" ? routineSheet() : taskSheet(null, tab === "calendar" ? calSelected : null));
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
