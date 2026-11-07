// ===== 共通処理：記録の保存先（Firebase / デモ）と表示用の関数 =====
(function () {
  // config.js に無い項目は既定値で補う（古い config.js のままでも動くように）
  const C = Object.assign({
    unit: "点",
    maxScore: 100,
    boardSize: 30,
    targets: [],
    anonName: "ひみつさん",
    rotateSec: 0,
    qrUrl: ""
  }, window.APP_CONFIG);
  window.APP_CONFIG = C;
  const FB_VER = "10.12.2";
  const useFirebase = !!(C.firebase && C.firebase.apiKey && C.firebase.databaseURL);
  const ANON_NAME = C.anonName || "ひみつさん";

  // ---------- 点数まわり ----------
  const fmtNum = n => Number(n).toLocaleString("ja-JP");

  // 点数の表示用要素（数字は大きく、単位は小さく）
  function scoreEl(score, cls) {
    const el = document.createElement("span");
    if (cls) el.className = cls;
    el.append(fmtNum(score));
    const u = document.createElement("small");
    u.textContent = C.unit;
    el.append(u);
    return el;
  }

  // 入力された点数を整数に変換（全角数字もOK）。範囲外や不正なら null
  function parseScore(input) {
    const s = String(input).trim().replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
    if (!/^\d{1,6}$/.test(s)) return null;
    const n = parseInt(s, 10);
    return n >= 0 && n <= C.maxScore ? n : null;
  }

  // 順位付け：点数が高い順 → 同じ点数なら先に登録した順。同じ点数の人は同順位
  function rank(records) {
    const r = records.map(x => ({ ...x })).sort((a, b) => b.score - a.score || a.at - b.at);
    r.forEach((x, i) => { x.rank = i > 0 && r[i - 1].score === x.score ? r[i - 1].rank : i + 1; });
    return r;
  }

  // 保存データを表示用の形に整える
  function clean(id, v) {
    v = v || {};
    const anon = v.anon === true;
    const at = Number(v.at) || 0;
    return {
      id,
      anon,
      name: anon ? ANON_NAME : String(v.name || "名無し").slice(0, 16),
      score: Math.max(0, Math.round(Number(v.score)) || 0),
      at,
      day: dayKey(at)
    };
  }

  // ---------- 日付まわり（会場の日本時間で区切る） ----------
  const JST_DATE = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" });
  const JST_HOUR = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tokyo", hour: "2-digit", hour12: false });
  const WEEK = ["日", "月", "火", "水", "木", "金", "土"];
  // 時刻 → "2026-11-14" のような日付キー
  function dayKey(at) { return at ? JST_DATE.format(new Date(at)) : ""; }
  // 時刻 → 0〜23 の「時」
  function hourOf(at) { return Number(JST_HOUR.format(new Date(at))) % 24; }
  // 日付キー → "11/14(土)"
  function dayLabel(key) {
    const [y, m, d] = key.split("-").map(Number);
    const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    return `${m}/${d}(${WEEK[w]})`;
  }
  // 記録に含まれる日付を古い順に並べる
  function daysOf(records) {
    return [...new Set(records.map(x => x.day).filter(Boolean))].sort();
  }

  // ---------- デモモード（Firebase未設定時。同じブラウザのタブ間で同期） ----------
  const DEMO_KEY = "shateki-demo-records";
  const DEMO_PRIV_KEY = "shateki-demo-private";
  const demoListeners = [];
  const demoPrivListeners = [];
  function demoLoad(key = DEMO_KEY) {
    try { return JSON.parse(localStorage.getItem(key) || "{}"); } catch (e) { return {}; }
  }
  function demoEmit() {
    const arr = Object.entries(demoLoad()).map(([k, v]) => clean(k, v));
    demoListeners.forEach(f => f(arr));
    const priv = demoLoad(DEMO_PRIV_KEY);
    demoPrivListeners.forEach(f => f(priv));
  }
  function demoSave(obj, priv) {
    try {
      localStorage.setItem(DEMO_KEY, JSON.stringify(obj));
      if (priv) localStorage.setItem(DEMO_PRIV_KEY, JSON.stringify(priv));
    } catch (e) {}
    demoEmit();
  }
  window.addEventListener("storage", e => { if (e.key === DEMO_KEY || e.key === DEMO_PRIV_KEY) demoEmit(); });

  // ---------- 保存先 ----------
  const Store = {
    mode: useFirebase ? "firebase" : "demo",

    async init({ auth = false } = {}) {
      if (!useFirebase) return;
      const base = "https://www.gstatic.com/firebasejs/" + FB_VER + "/";
      const appMod = await import(base + "firebase-app.js");
      this.fb = await import(base + "firebase-database.js");
      this.app = appMod.initializeApp(C.firebase);
      this.db = this.fb.getDatabase(this.app);
      if (auth) {
        this.fa = await import(base + "firebase-auth.js");
        this.auth = this.fa.getAuth(this.app);
      }
    },

    // 記録をリアルタイムで受け取る。onStatus(つながっているか)
    subscribe(onData, onStatus) {
      if (!useFirebase) {
        demoListeners.push(onData);
        onStatus(true);
        demoEmit();
        return;
      }
      const { ref, onValue } = this.fb;
      onValue(ref(this.db, ".info/connected"), s => onStatus(s.val() === true));
      onValue(ref(this.db, "records"), snap => {
        const out = [];
        snap.forEach(ch => { out.push(clean(ch.key, ch.val())); });
        onData(out);
      }, () => onStatus(false));
    },

    // 記録を追加。anon = true のときは公開データに名前を入れず、
    // 本名（入力があれば）は受付だけが読める private に分けて保存する
    async add(name, score, anon = false) {
      const rec = { name: anon ? "" : name, score };
      if (anon) rec.anon = true;
      if (!useFirebase) {
        const o = demoLoad(), p = demoLoad(DEMO_PRIV_KEY);
        const id = "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        o[id] = { ...rec, at: Date.now() };
        if (anon && name) p[id] = { name };
        demoSave(o, p);
        return;
      }
      const { ref, push, update, serverTimestamp } = this.fb;
      const key = push(ref(this.db, "records")).key;   // 先にIDだけ発行
      const changes = { ["records/" + key]: { ...rec, at: serverTimestamp() } };
      if (anon && name) changes["private/" + key] = { name };
      await update(ref(this.db), changes);             // 2か所まとめて書き込む
    },

    async remove(id) {
      if (!useFirebase) {
        const o = demoLoad(), p = demoLoad(DEMO_PRIV_KEY);
        delete o[id]; delete p[id];
        demoSave(o, p);
        return;
      }
      const { ref, update } = this.fb;
      await update(ref(this.db), { ["records/" + id]: null, ["private/" + id]: null });
    },

    // 全記録を削除（匿名の人の名前もまとめて消す）
    async removeAll() {
      if (!useFirebase) { demoSave({}, {}); return; }
      const { ref, update } = this.fb;
      await update(ref(this.db), { records: null, private: null });
    },

    // 匿名の人の本名（受付用）。{ 記録ID: { name } } の形で届く
    subscribePrivate(onData) {
      if (!useFirebase) { demoPrivListeners.push(onData); demoEmit(); return; }
      const { ref, onValue } = this.fb;
      onValue(ref(this.db, "private"), snap => onData(snap.val() || {}), () => onData({}));
    },

    // 画面が裏に回ったら接続を切る（無料枠の同時接続数100を節約）
    pause() { if (useFirebase && this.db) this.fb.goOffline(this.db); },
    resume() { if (useFirebase && this.db) this.fb.goOnline(this.db); },

    // ---------- 受付用ログイン ----------
    onAuth(cb) {
      // デモでも Firebase と同じく「後から」呼ぶ（ページ側の準備が終わってから描画させるため）
      if (!useFirebase) { queueMicrotask(() => cb({ uid: "demo", email: "デモモード" })); return; }
      this.fa.onAuthStateChanged(this.auth, cb);
    },
    signIn(email, pw) { return this.fa.signInWithEmailAndPassword(this.auth, email, pw); },
    signOut() { return useFirebase ? this.fa.signOut(this.auth) : Promise.resolve(); }
  };

  window.SKT = { C, ANON_NAME, fmtNum, scoreEl, parseScore, rank, clean, dayKey, hourOf, dayLabel, daysOf, Store };
})();
