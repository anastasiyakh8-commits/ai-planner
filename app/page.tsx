"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Priority = "high" | "medium" | "low";

type Task = {
  id: string;
  title: string;
  priority: Priority;
  list: "today" | "inbox";
  time: string | null;
  deadline: string | null;
  done: boolean;
  createdAt: number;
};

type View = "welcome" | "today" | "all" | "capture" | "confirm" | "thought";
type Mood = "idle" | "listening" | "thinking" | "happy" | "calm";

const STORAGE_KEY = "ai-planner-tasks-v1";
const SEEN_KEY = "nora_seen";

const PROCESS_PHRASES = [
  "Розділяю на окремі справи…",
  "Визначаю, що важливо сьогодні…",
  "Формую твій план…",
];

const EXAMPLE_DUMP =
  "Підготувати презентацію для інвесторів до пʼятниці, подзвонити підряднику о 14:00, купити подарунок мамі та розібрати пошту";

const DONE_REACTIONS = [
  "🎯 Один крок зроблено. Гарний темп.",
  "⚡ Ще одна є. Рухаємось.",
  "🌿 Зроблено. Стало легше, правда?",
  "💪 Є! День піддається.",
];

const PRIORITY_ORDER: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

/* iOS Safari погано тримає безперервне розпізнавання — вмикаємо сумісний режим */
function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}

function speechErrorText(code: string): string {
  if (code === "not-allowed" || code === "service-not-allowed")
    return "Дай браузеру доступ до мікрофона (у налаштуваннях сайту) — або надрукуй текстом.";
  if (code === "no-speech")
    return "Я нічого не почула. Спробуй ще раз ближче до мікрофона.";
  return "Голос у цьому браузері вередує. Найкраще він працює в Chrome — або просто надрукуй текстом.";
}

function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function todayIso(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function isoOfDaysFromNow(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/* Людська мітка дедлайну: «сьогодні», «завтра» або «до 25.07» */
function deadlineLabel(iso: string): string {
  if (iso === todayIso()) return "сьогодні";
  if (iso === isoOfDaysFromNow(1)) return "завтра";
  const parts = iso.split("-").map(Number);
  const m = parts[1];
  const d = parts[2];
  if (!m || !d) return iso;
  return `до ${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}`;
}

function greeting(): string {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return "Доброго ранку";
  if (h >= 12 && h < 18) return "Доброго дня";
  if (h >= 18 && h < 23) return "Доброго вечора";
  return "Не спиться?";
}

/* М'яке виявлення дублікатів: схожість рядків за біграмами (Dice) */
function bigramCounts(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const bg = s.slice(i, i + 2);
    m.set(bg, (m.get(bg) || 0) + 1);
  }
  return m;
}

function normalizeTitle(s: string): string {
  // Без unicode-класів (\p{...}) — сумісно з target ES5 у tsconfig
  return s
    .toLowerCase()
    .replace(/[^a-z0-9а-яіїєґ\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function looksDuplicate(a: string, b: string): boolean {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ma = bigramCounts(na);
  const mb = bigramCounts(nb);
  let inter = 0;
  let totalA = 0;
  let totalB = 0;
  ma.forEach((c) => (totalA += c));
  mb.forEach((c) => (totalB += c));
  ma.forEach((c, bg) => {
    const cb = mb.get(bg);
    if (cb) inter += Math.min(c, cb);
  });
  if (totalA + totalB === 0) return false;
  return (2 * inter) / (totalA + totalB) >= 0.7;
}

function spravPlural(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} справу`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} справи`;
  return `${n} справ`;
}

function spravCount(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} справа`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} справи`;
  return `${n} справ`;
}

/* Прострочене = дедлайн у минулому АБО сьогодні, але вказаний час уже минув.
   Дедлайн «сьогодні» без часу — це «зроби сьогодні», не провал. */
function isBurning(t: Task): boolean {
  if (!t.deadline || t.done) return false;
  const today = todayIso();
  if (t.deadline < today) return true;
  if (t.deadline === today && t.time) {
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(
      now.getMinutes()
    ).padStart(2, "0")}`;
    return t.time < hhmm;
  }
  return false;
}

/* Порядок дня: прострочені → дедлайн сьогодні (за часом) → важливі →
   найближчі дедлайни → з часом → решта. Нові й старі справи змішуються чесно. */
function sortTasks(list: Task[]): Task[] {
  const today = todayIso();
  const rank = (t: Task): number => {
    if (isBurning(t)) return 0;
    if (t.deadline === today) return 1;
    if (t.priority === "high") return 2;
    if (t.deadline) return 3;
    if (t.time) return 4;
    return 5;
  };
  return [...list].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (a.deadline && b.deadline && a.deadline !== b.deadline)
      return a.deadline < b.deadline ? -1 : 1;
    if (PRIORITY_ORDER[a.priority] !== PRIORITY_ORDER[b.priority]) {
      return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    }
    if (a.time && b.time) return a.time.localeCompare(b.time);
    if (a.time) return -1;
    if (b.time) return 1;
    return a.createdAt - b.createdAt;
  });
}

/* Одна рекомендація Нори — на основі фактів, а не вигаданих оцінок */
function recommendReason(t: Task): string {
  if (isBurning(t)) return "вона прострочена, краще закрити її першою";
  if (t.priority === "high" && t.deadline)
    return "вона важлива і має найближчий дедлайн";
  if (t.priority === "high") return "ти позначила її важливою";
  if (t.time) return `вона привʼязана до часу ${t.time}`;
  return "вона перша в черзі";
}

/* Свайп вліво → видалити (з кнопкою-фолбеком для десктопа) */
function SwipeRow({
  onDelete,
  children,
}: {
  onDelete: () => void;
  children: React.ReactNode;
}) {
  const [dx, setDx] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const horiz = useRef(false);
  const dragging = start.current !== null;
  return (
    <div className="relative overflow-hidden rounded-2xl">
      <div
        className="absolute inset-0 flex items-center justify-end rounded-2xl bg-[#A8402F]/10 pr-5 text-sm font-medium text-[#A8402F] transition-opacity"
        style={{ opacity: dx < -24 || leaving ? 1 : 0 }}
        aria-hidden
      >
        Видалити
      </div>
      <div
        style={{
          transform: `translateX(${leaving ? -560 : dx}px)`,
          transition: dragging ? "none" : "transform 0.25s ease",
        }}
        onTouchStart={(e) => {
          const t = e.touches[0];
          start.current = { x: t.clientX, y: t.clientY };
          horiz.current = false;
        }}
        onTouchMove={(e) => {
          if (!start.current) return;
          const t = e.touches[0];
          const ddx = t.clientX - start.current.x;
          const ddy = t.clientY - start.current.y;
          if (
            !horiz.current &&
            Math.abs(ddx) > 12 &&
            Math.abs(ddx) > Math.abs(ddy)
          ) {
            horiz.current = true;
          }
          if (horiz.current) setDx(Math.min(0, ddx));
        }}
        onTouchEnd={() => {
          start.current = null;
          if (dx < -80) {
            setLeaving(true);
            setTimeout(onDelete, 220);
          } else {
            setDx(0);
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}

function Nora({ mood, size }: { mood: Mood; size: number }) {
  return (
    <div
      className={`nora nora--${mood} flex-none`}
      style={{ width: size, height: size }}
      aria-hidden
    />
  );
}

function MicIcon({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden
    >
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </svg>
  );
}

export default function Home() {
  const [mounted, setMounted] = useState(false);
  const [view, setView] = useState<View>("today");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [draft, setDraft] = useState("");
  const [listening, setListening] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [phrase, setPhrase] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Task[]>([]);
  const [pendingEditIdx, setPendingEditIdx] = useState<number | null>(null);
  const [pendingEditText, setPendingEditText] = useState("");
  const [lastBatch, setLastBatch] = useState<Task[]>([]);
  const [reaction, setReaction] = useState<string | null>(null);
  const [editing, setEditing] = useState<Task | null>(null);

  const recognitionRef = useRef<any>(null);
  const baseTextRef = useRef("");

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) setTasks(JSON.parse(saved));
      if (localStorage.getItem(SEEN_KEY) !== "1") setView("welcome");
    } catch {
      // ignore
    }
    const SR =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;
    setSpeechSupported(Boolean(SR));
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
    } catch {
      // ignore
    }
  }, [tasks, mounted]);

  useEffect(() => {
    if (!parsing) return;
    setPhrase(0);
    const t = setInterval(
      () => setPhrase((p) => (p + 1) % PROCESS_PHRASES.length),
      1000
    );
    return () => clearInterval(t);
  }, [parsing]);

  const markSeen = useCallback(() => {
    try {
      localStorage.setItem(SEEN_KEY, "1");
    } catch {
      // ignore
    }
  }, []);

  const stopListening = useCallback(() => {
    try {
      recognitionRef.current?.stop();
    } catch {
      // ignore
    }
    setListening(false);
  }, []);

  const toggleListening = useCallback(() => {
    if (listening) {
      stopListening();
      return;
    }
    const SR =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;
    if (!SR) return;
    const rec = new SR();
    rec.lang = "uk-UA";
    rec.continuous = !isIOS(); // на iOS безперервний режим не віддає текст
    rec.interimResults = true;
    baseTextRef.current = draft ? draft.trimEnd() + " " : "";
    rec.onresult = (e: any) => {
      let finalText = "";
      let interim = "";
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      setDraft(baseTextRef.current + finalText + interim);
    };
    rec.onend = () => setListening(false);
    rec.onerror = (e: any) => {
      setListening(false);
      if (e?.error !== "aborted") setError(speechErrorText(e?.error || ""));
    };
    recognitionRef.current = rec;
    try {
      rec.start();
      setListening(true);
      setError(null);
    } catch {
      setListening(false);
    }
  }, [draft, listening, stopListening]);

  const parse = useCallback(async () => {
    const text = draft.trim();
    if (!text || parsing) return;
    stopListening();
    setParsing(true);
    setError(null);
    try {
      const res = await fetch("/api/parse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || "Щось мені завадило подумати. Спробуймо ще раз?");
        return;
      }
      const incoming: Task[] = (data.tasks || []).map(
        (
          t: {
            title: string;
            priority: Priority;
            list: Task["list"];
            time: string | null;
            deadline: string | null;
          },
          i: number
        ) => ({
          title: t.title,
          priority: t.priority,
          time: t.time,
          deadline: t.deadline,
          // Продуктові правила: важливе і те, що має дедлайн сьогодні/прострочене — у «Мій день».
          list:
            t.priority === "high" ||
            (t.deadline && t.deadline <= todayIso())
              ? ("today" as const)
              : t.list,
          id: uid(),
          done: false,
          createdAt: Date.now() + i,
        })
      );
      setPending(incoming);
      setPendingEditIdx(null);
      setView("confirm");
    } catch {
      setError("Звʼязок загубився. Перевір інтернет — і спробуймо ще раз.");
    } finally {
      setParsing(false);
    }
  }, [draft, parsing, stopListening]);

  const savePendingEdit = useCallback(() => {
    setPendingEditIdx((idx) => {
      if (idx !== null) {
        const text = pendingEditText.trim();
        if (text) {
          setPending((prev) =>
            prev.map((t, i) => (i === idx ? { ...t, title: text } : t))
          );
        }
      }
      return null;
    });
  }, [pendingEditText]);

  const removePending = useCallback((idx: number) => {
    setPending((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      if (next.length === 0) {
        // Усе прибрано — повертаємось до запису
        setDraft("");
        setError(null);
        setView("capture");
      }
      return next;
    });
    setPendingEditIdx(null);
  }, []);

  const togglePendingDay = useCallback((idx: number) => {
    setPending((prev) =>
      prev.map((t, i) =>
        i === idx
          ? { ...t, list: t.list === "today" ? ("inbox" as const) : ("today" as const) }
          : t
      )
    );
  }, []);

  const togglePendingImportant = useCallback((idx: number) => {
    setPending((prev) =>
      prev.map((t, i) => {
        if (i !== idx) return t;
        const nowHigh = t.priority !== "high";
        return {
          ...t,
          priority: nowHigh ? ("high" as const) : ("medium" as const),
          // «Важливо» тягне справу в «Мій день»; зняття позначки нічого не забирає
          list: nowHigh ? ("today" as const) : t.list,
        };
      })
    );
  }, []);

  const confirmPending = useCallback(() => {
    setTasks((prev) => [...prev, ...pending]);
    setLastBatch(pending);
    setPending([]);
    setDraft("");
    setView("thought");
  }, [pending]);

  const retryCapture = useCallback(() => {
    setPending([]);
    setDraft("");
    setError(null);
    setView("capture");
  }, []);

  const toggleDone = useCallback((id: string) => {
    setTasks((prev) => {
      const next = prev.map((t) => (t.id === id ? { ...t, done: !t.done } : t));
      const t = next.find((x) => x.id === id);
      if (t?.done) {
        const dayList = next.filter(
          (x) => x.list === "today" || isBurning(x)
        );
        const left = dayList.filter((x) => !x.done).length;
        setReaction(
          left === 0 && dayList.length > 0
            ? "🏆 Усе виконано. Сьогодні ти молодець."
            : DONE_REACTIONS[Math.floor(Math.random() * DONE_REACTIONS.length)]
        );
        setTimeout(() => setReaction(null), 3000);
      }
      return next;
    });
  }, []);

  const removeTask = useCallback((id: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== id));
    setEditing(null);
  }, []);

  const saveTask = useCallback((updated: Task) => {
    setTasks((prev) => {
      const exists = prev.some((t) => t.id === updated.id);
      return exists
        ? prev.map((t) => (t.id === updated.id ? updated : t))
        : [...prev, updated];
    });
    setEditing(null);
  }, []);

  // Нова справа, додана вручну, теж проходить через Нору:
  // «обід сьогодні до восьмої» → чиста назва + час + дедлайн + «Мій день».
  const createSmart = useCallback(async (draftTask: Task): Promise<void> => {
    let final = draftTask;
    try {
      const res = await fetch("/api/parse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: draftTask.title }),
      });
      if (res.ok) {
        const data = await res.json();
        const p = (data.tasks || [])[0];
        if (p && typeof p.title === "string" && p.title) {
          final = {
            ...draftTask,
            title: p.title,
            time: draftTask.time || p.time || null,
            deadline: draftTask.deadline || p.deadline || null,
            priority:
              draftTask.priority === "high" ? "high" : p.priority || "medium",
          };
        }
      }
    } catch {
      // AI недоступний — зберігаємо як введено, нічого не губимо
    }
    const goesToday =
      final.priority === "high" ||
      Boolean(final.deadline && final.deadline <= todayIso());
    final = { ...final, list: goesToday ? "today" : final.list };
    setTasks((prev) => [...prev, final]);
    setEditing(null);
  }, []);

  // Закрити день: виконане зроблене — прибираємо його зі списків
  const clearDone = useCallback(() => {
    setTasks((prev) => {
      const wasAllDone =
        prev.filter((t) => t.list === "today" || isBurning(t)).length > 0 &&
        prev
          .filter((t) => t.list === "today" || isBurning(t))
          .every((t) => t.done);
      setReaction(
        wasAllDone
          ? "🌙 День закрито. Побачимось завтра."
          : "🧹 Виконане прибрано. Далі — по черзі."
      );
      setTimeout(() => setReaction(null), 3500);
      return prev.filter((t) => !t.done);
    });
  }, []);

  const startCreate = useCallback(() => {
    setEditing({
      id: uid(),
      title: "",
      priority: "medium",
      list: "inbox",
      time: null,
      deadline: null,
      done: false,
      createdAt: Date.now(),
    });
  }, []);

  const moveToToday = useCallback((id: string) => {
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, list: "today" as const } : t))
    );
    setEditing(null);
  }, []);

  // «Відкласти на потім» знімає позначку «Важливо» — інакше правило
  // «важливе завжди в Моєму дні» повертало б задачу назад.
  const postpone = useCallback((id: string) => {
    setTasks((prev) =>
      prev.map((t) =>
        t.id === id
          ? {
              ...t,
              list: "inbox" as const,
              priority: t.priority === "high" ? ("medium" as const) : t.priority,
            }
          : t
      )
    );
    setEditing(null);
    setReaction("📦 Перенесла на потім. Нічого не загубиться.");
    setTimeout(() => setReaction(null), 3000);
  }, []);

  const activeTasks = tasks.filter((t) => !t.done);
  // «Мій день» = обране в день + прострочене (його не ховаємо ніколи)
  const dayList = sortTasks(
    tasks.filter((t) => t.list === "today" || isBurning(t))
  );
  const doneCount = dayList.filter((t) => t.done).length;
  const allDone = dayList.length > 0 && doneCount === dayList.length;
  const progressPct =
    dayList.length > 0 ? Math.round((doneCount / dayList.length) * 100) : 0;
  const firstOpen = dayList.find((t) => !t.done);

  const mood: Mood = parsing
    ? "thinking"
    : listening
    ? "listening"
    : view === "thought"
    ? "happy"
    : allDone && view === "today"
    ? "calm"
    : "idle";

  if (!mounted) return <main className="min-h-dvh" />;

  /* ─────────── WELCOME ─────────── */
  if (view === "welcome") {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-8 px-6 pb-16 text-center">
        <Nora mood="idle" size={112} />
        <div>
          <p className="serif rise mb-6 text-xs uppercase tracking-[0.35em] text-[#6E6A61]">
            НОРА
          </p>
          <div className="serif space-y-2 text-[22px] leading-snug text-[#191815]">
            <p className="rise-1">Я Нора.</p>
            <p className="rise-1">Ти можеш не думати про списки.</p>
            <p className="rise-2">Просто розкажи, що сьогодні на думці.</p>
            <p className="rise-3 font-semibold">Далі — моя робота.</p>
          </div>
        </div>
        <button
          onClick={() => {
            markSeen();
            setView("capture");
          }}
          className="rise-4 w-full max-w-xs rounded-2xl bg-[#191815] px-6 py-4 text-[16px] font-medium text-[#F6F5F2] transition active:scale-[0.98]"
        >
          Розповісти
        </button>
      </main>
    );
  }

  /* ─────────── CAPTURE ─────────── */
  if (view === "capture") {
    if (parsing) {
      return (
        <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-8 px-6 pb-16 text-center">
          <Nora mood="thinking" size={112} />
          <p className="serif rise text-[18px] italic text-[#6E6A61]">
            {PROCESS_PHRASES[phrase]}
          </p>
        </main>
      );
    }
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-6 pb-10 pt-6">
        <button
          onClick={() => {
            stopListening();
            setView("today");
          }}
          className="self-start text-sm text-[#6E6A61] transition active:text-[#191815]"
        >
          ← Мій день
        </button>

        <div className="mt-6 flex flex-col items-center gap-6 text-center">
          <Nora mood={mood} size={96} />
          <h1 className="serif text-[24px] leading-snug text-[#191815]">
            Що сьогодні займає твої думки?
          </h1>

          {speechSupported && (
            <button
              onClick={toggleListening}
              className={`flex w-full max-w-xs items-center justify-center gap-2 rounded-2xl px-6 py-4 text-[16px] font-medium transition active:scale-[0.98] ${
                listening
                  ? "bg-[#B5793A] text-white"
                  : "bg-[#191815] text-[#F6F5F2]"
              }`}
            >
              <MicIcon />
              {listening ? "Слухаю… натисни, коли закінчиш" : "Говорити"}
            </button>
          )}

          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Або запиши текстом…"
            rows={4}
            className="w-full resize-none rounded-2xl border border-[#E8E5DF] bg-white/70 p-4 text-left text-[16px] leading-relaxed text-[#191815] placeholder-[#6E6A61] outline-none focus:border-[#C88A4E]"
          />

          {error && (
            <p className="w-full rounded-xl bg-[#F7E7E2] p-3 text-sm text-[#A8402F]">
              {error}
            </p>
          )}

          {draft.trim() && !listening && (
            <button
              onClick={parse}
              className="rise w-full max-w-xs rounded-2xl bg-[#191815] px-6 py-4 text-[16px] font-medium text-[#F6F5F2] transition active:scale-[0.98]"
            >
              Далі
            </button>
          )}

          {!draft.trim() && !listening && (
            <button
              onClick={() => setDraft(EXAMPLE_DUMP)}
              className="text-sm text-[#6E6A61] underline-offset-4 transition active:text-[#191815]"
            >
              ✨ Заповнити прикладом
            </button>
          )}
        </div>
      </main>
    );
  }

  /* ─────────── «Ось що я зрозуміла» ─────────── */
  if (view === "confirm") {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-6 pb-10 pt-8">
        <div className="flex flex-col items-center gap-2 text-center">
          <Nora mood="idle" size={64} />
          <h1 className="serif mt-3 text-[24px] leading-snug text-[#191815]">
            Ось що я зрозуміла
          </h1>
          <p className="text-sm text-[#6E6A61]">Перевір, чи все правильно</p>
        </div>

        <ul className="mt-6 flex flex-col gap-2">
          {pending.map((t, idx) => {
            const dupe =
              tasks.some(
                (x) => !x.done && looksDuplicate(x.title, t.title)
              ) ||
              pending.some(
                (x, j) => j < idx && looksDuplicate(x.title, t.title)
              );
            return (
            <li
              key={t.id}
              className="rise"
              style={{ animationDelay: `${idx * 70}ms` }}
            >
             <SwipeRow onDelete={() => removePending(idx)}>
              <div className="rounded-2xl border border-[#E8E5DF] bg-white/70 p-3.5">
              {pendingEditIdx === idx ? (
                <input
                  value={pendingEditText}
                  onChange={(e) => setPendingEditText(e.target.value)}
                  onBlur={savePendingEdit}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") savePendingEdit();
                    if (e.key === "Escape") setPendingEditIdx(null);
                  }}
                  autoFocus
                  className="w-full rounded-xl border border-[#C88A4E] bg-white p-2 text-[16px] text-[#191815] outline-none"
                />
              ) : (
                <>
                  <div className="flex items-start gap-2">
                    <button
                      onClick={() => {
                        setPendingEditIdx(idx);
                        setPendingEditText(t.title);
                      }}
                      className="min-w-0 flex-1 text-left text-[16px] leading-snug text-[#191815]"
                    >
                      {t.title}
                    </button>
                    <button
                      onClick={() => removePending(idx)}
                      aria-label="Видалити зі списку"
                      className="flex h-7 w-7 flex-none items-center justify-center rounded-lg text-[#6E6A61] transition active:scale-90 active:text-[#A8402F]"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => togglePendingDay(idx)}
                      className={`rounded-full px-3 py-1 text-xs font-medium transition active:scale-95 ${
                        t.list === "today"
                          ? "bg-[#191815] text-[#F6F5F2]"
                          : "border border-[#E8E5DF] text-[#6E6A61]"
                      }`}
                    >
                      {t.list === "today" ? "Мій день ✓" : "На потім"}
                    </button>
                    <button
                      onClick={() => togglePendingImportant(idx)}
                      className={`rounded-full px-3 py-1 text-xs font-medium transition active:scale-95 ${
                        t.priority === "high"
                          ? "bg-[#F6DDB8]/70 text-[#B5793A]"
                          : "border border-[#E8E5DF] text-[#6E6A61]"
                      }`}
                    >
                      {t.priority === "high" ? "Важливо ✓" : "Важливо"}
                    </button>
                    {t.time && (
                      <span className="text-xs font-semibold text-[#191815]">
                        {t.time}
                      </span>
                    )}
                    {t.deadline && (
                      <span className="text-xs text-[#6E6A61]">
                        {deadlineLabel(t.deadline)}
                      </span>
                    )}
                  </div>
                  {dupe && (
                    <p className="mt-1.5 text-xs text-[#B5793A]">
                      Схоже, така справа вже є — перевір, чи не дубль
                    </p>
                  )}
                </>
              )}
              </div>
             </SwipeRow>
            </li>
            );
          })}
        </ul>
        <p className="mt-2 text-center text-xs text-[#6E6A61]">
          Тапни назву чи мітку — змінити · свайп вліво чи ✕ — видалити
        </p>

        <div className="mt-6 flex flex-col gap-2">
          <button
            onClick={confirmPending}
            className="w-full rounded-2xl bg-[#191815] px-6 py-4 text-[16px] font-medium text-[#F6F5F2] transition active:scale-[0.98]"
          >
            Все правильно
          </button>
          <button
            onClick={retryCapture}
            className="w-full rounded-2xl border border-[#E8E5DF] px-6 py-3.5 text-[16px] text-[#6E6A61] transition active:scale-[0.98]"
          >
            Записати ще раз
          </button>
        </div>
      </main>
    );
  }

  /* ─────────── РЕЗУЛЬТАТ ─────────── */
  if (view === "thought") {
    const n = lastBatch.length;
    const attention = lastBatch.filter((t) => t.list === "today").length;
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-8 px-6 pb-16 text-center">
        <Nora mood="happy" size={96} />
        <div className="serif space-y-3 text-[20px] leading-snug text-[#191815]">
          <p className="rise-1">Готово.</p>
          <p className="rise-2">
            {attention > 0
              ? `Я виділила ${spravPlural(n)} й додала ${attention} у твій день.`
              : `Я виділила ${spravPlural(n)} — усі можуть почекати, я їх збережу.`}
          </p>
        </div>
        <button
          onClick={() => setView("today")}
          className="rise-3 w-full max-w-xs rounded-2xl bg-[#191815] px-6 py-4 text-[16px] font-medium text-[#F6F5F2] transition active:scale-[0.98]"
        >
          Показати мій день
        </button>
      </main>
    );
  }

  /* ─────────── ГОЛОВНИЙ ЕКРАН: вкладки ─────────── */
  const isToday = view === "today";

  // «На потім» — тільки те, чого НЕМАЄ в «Моєму дні» (два кошики без дублювання)
  const laterTasks = tasks.filter(
    (t) => !t.done && t.list === "inbox" && !isBurning(t)
  );
  const withDeadline = [...laterTasks]
    .filter((t) => t.deadline)
    .sort((a, b) => ((a.deadline || "") < (b.deadline || "") ? -1 : 1));
  const noDeadline = sortTasks(laterTasks.filter((t) => !t.deadline));
  const groups: { label: string; items: Task[]; alert?: boolean }[] = [
    { label: "З дедлайном", items: withDeadline },
    { label: "Без дедлайну", items: noDeadline },
  ];

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-5 px-6 pb-32 pt-8">
      <header className="flex flex-col items-center gap-2 text-center">
        <Nora mood={mood} size={56} />
        <p className="text-sm text-[#6E6A61]">{greeting()}.</p>
      </header>

      <nav className="relative grid grid-cols-2 rounded-2xl border border-[#E8E5DF] bg-white/60 p-1">
        <div
          className={`absolute bottom-1 top-1 w-[calc(50%-4px)] rounded-xl bg-[#191815] transition-transform duration-300 ease-out ${
            isToday ? "translate-x-1" : "translate-x-[calc(100%+3px)]"
          }`}
          aria-hidden
        />
        <button
          onClick={() => setView("today")}
          className={`relative z-10 py-3 text-sm font-medium transition-colors duration-300 ${
            isToday ? "text-[#F6F5F2]" : "text-[#6E6A61]"
          }`}
        >
          Мій день{dayList.length > 0 ? ` · ${dayList.length}` : ""}
        </button>
        <button
          onClick={() => setView("all")}
          className={`relative z-10 py-3 text-sm font-medium transition-colors duration-300 ${
            !isToday ? "text-[#F6F5F2]" : "text-[#6E6A61]"
          }`}
        >
          На потім
          {tasks.filter((t) => !t.done && t.list === "inbox" && !isBurning(t))
            .length > 0
            ? ` · ${tasks.filter((t) => !t.done && t.list === "inbox" && !isBurning(t)).length}`
            : ""}
        </button>
      </nav>

      {reaction && (
        <p className="rise rounded-2xl bg-[#6E9C86]/10 p-3 text-center text-sm text-[#6E9C86]">
          {reaction}
        </p>
      )}

      <div key={view} className="tab-in flex flex-col gap-4">
        {isToday ? (
          <>
            {dayList.length > 0 && (
              <div className="rounded-2xl border border-[#E8E5DF] bg-white/60 p-3.5">
                <div className="flex items-baseline justify-between text-sm">
                  <span className="font-medium text-[#191815]">
                    Сьогодні {spravCount(dayList.length)}
                  </span>
                  <span className="flex-none text-[#6E6A61]">
                    виконано {progressPct}%
                  </span>
                </div>
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[#E8E5DF]">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-[#F6DDB8] to-[#C88A4E] transition-all duration-700"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
              </div>
            )}

            {allDone && !reaction && (
              <div className="rise rounded-2xl bg-[#6E9C86]/10 p-3 text-center">
                <p className="text-sm text-[#6E9C86]">
                  🏆 Усе виконано. Сьогодні ти молодець.
                </p>
                <p className="mt-1 text-xs text-[#6E6A61]">
                  Можеш видихнути. Якщо щось спливе — я поруч 🎙
                </p>
              </div>
            )}

            {firstOpen && !allDone && !reaction && (
              <p className="serif text-center text-[16px] italic leading-relaxed text-[#6E6A61]">
                Почни з «{firstOpen.title}» — {recommendReason(firstOpen)}.
              </p>
            )}

            {dayList.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-[#E8E5DF] p-8 text-center">
                <p className="serif text-[17px] text-[#191815]">Поки тихо.</p>
                <p className="mt-1 text-sm text-[#6E6A61]">
                  Розкажи, що на думці.
                </p>
              </div>
            ) : (
              <>
                <ul className="flex flex-col gap-2">
                  {dayList.map((t, i) => (
                    <TaskRow
                      key={t.id}
                      task={t}
                      index={i}
                      onToggle={toggleDone}
                      onEdit={() => setEditing(t)}
                    />
                  ))}
                </ul>
                {doneCount > 0 && (
                  <button
                    onClick={clearDone}
                    className="self-center text-sm text-[#6E6A61] underline underline-offset-4 transition active:text-[#191815]"
                  >
                    {allDone ? "Закрити день" : "Прибрати виконані"}
                  </button>
                )}
              </>
            )}
          </>
        ) : (
          <>
            <button
              onClick={startCreate}
              className="rounded-2xl border border-dashed border-[#C88A4E]/50 py-3 text-sm font-medium text-[#B5793A] transition active:scale-[0.98]"
            >
              + Додати справу
            </button>
            {laterTasks.length === 0 && (
              <div className="rounded-2xl border border-dashed border-[#E8E5DF] p-8 text-center">
                <p className="serif text-[17px] text-[#191815]">
                  На потім нічого немає.
                </p>
                <p className="mt-1 text-sm text-[#6E6A61]">
                  Все або в «Моєму дні», або ще в твоїй голові 🎙
                </p>
              </div>
            )}
            {groups.map(
              (g) =>
                g.items.length > 0 && (
                  <section key={g.label}>
                    <h2 className="mb-2 text-center text-xs font-medium uppercase tracking-wider text-[#6E6A61]">
                      {g.label}
                    </h2>
                    <ul className="flex flex-col gap-2">
                      {g.items.map((t, i) => (
                        <TaskRow
                          key={t.id}
                          task={t}
                          index={i}
                          onToggle={toggleDone}
                          onEdit={() => setEditing(t)}
                          onMoveToday={moveToToday}
                        />
                      ))}
                    </ul>
                  </section>
                )
            )}
          </>
        )}
      </div>

      <MicFab
        onClick={() => {
          setDraft("");
          setView("capture");
        }}
      />

      {editing && (
        <EditSheet
          task={editing}
          speechSupported={speechSupported}
          onClose={() => setEditing(null)}
          onSave={saveTask}
          onCreateSmart={createSmart}
          onPostpone={postpone}
          onMoveToday={moveToToday}
          onDelete={removeTask}
        />
      )}
    </main>
  );
}

/* ─────────── Компоненти ─────────── */

function MicFab({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label="Розповісти Норі"
      className="fixed bottom-6 left-1/2 z-40 flex h-16 w-16 -translate-x-1/2 items-center justify-center rounded-full bg-[#191815] text-[#F6F5F2] shadow-lg shadow-black/25 transition active:scale-95"
    >
      <MicIcon size={26} />
    </button>
  );
}

function TaskRow({
  task,
  index,
  onToggle,
  onEdit,
  onMoveToday,
}: {
  task: Task;
  index: number;
  onToggle: (id: string) => void;
  onEdit: () => void;
  onMoveToday?: (id: string) => void;
}) {
  const burning = isBurning(task);
  const important = task.priority === "high" && !burning;
  const hasMeta = burning || important || task.time || task.deadline;

  const surface = burning
    ? "border-l-4 border-[#E8E5DF] border-l-[#A8402F] bg-[#F7E7E2]"
    : important
    ? "border-[#C88A4E]/60 bg-[#F6DDB8]/35"
    : "border-[#E8E5DF] bg-white/70";

  return (
    <li
      className={`rise flex items-center gap-3 rounded-2xl border p-3.5 transition ${surface} ${
        task.done ? "opacity-45" : ""
      }`}
      style={{ animationDelay: `${index * 60}ms` }}
    >
      <button
        onClick={() => onToggle(task.id)}
        aria-label="Виконано"
        className={`flex h-7 w-7 flex-none items-center justify-center rounded-full border-2 text-sm transition active:scale-90 ${
          task.done
            ? "checkpop border-[#6E9C86] bg-[#6E9C86]/15 text-[#6E9C86]"
            : "border-[#D8D4CC] text-transparent"
        }`}
      >
        ✓
      </button>
      <div
        className="min-w-0 flex-1 cursor-pointer"
        onClick={onEdit}
        role="button"
        aria-label="Редагувати справу"
      >
        <p
          className={`text-[16px] leading-snug text-[#191815] ${
            task.done ? "line-through" : ""
          }`}
        >
          {task.title}
        </p>
        {hasMeta && (
          <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-[#6E6A61]">
            {burning && (
              <span className="rounded-full bg-[#A8402F]/10 px-2 py-0.5 font-medium text-[#A8402F]">
                прострочено
              </span>
            )}
            {important && (
              <span className="font-medium text-[#B5793A]">Важливо</span>
            )}
            {task.time && (
              <span className="font-semibold text-[#191815]">{task.time}</span>
            )}
            {task.deadline && !burning && (
              <span>{deadlineLabel(task.deadline)}</span>
            )}
          </p>
        )}
      </div>
      {onMoveToday && (
        <button
          onClick={() => onMoveToday(task.id)}
          className="flex-none rounded-full border border-[#C88A4E]/50 px-2.5 py-1.5 text-xs font-medium text-[#B5793A] transition active:scale-95"
        >
          У день →
        </button>
      )}
      <button
        onClick={onEdit}
        aria-label="Редагувати"
        className="flex h-9 w-9 flex-none items-center justify-center rounded-xl text-[#6E6A61] transition active:scale-90 active:text-[#191815]"
      >
        ✎
      </button>
    </li>
  );
}

function EditSheet({
  task,
  speechSupported,
  onClose,
  onSave,
  onCreateSmart,
  onPostpone,
  onMoveToday,
  onDelete,
}: {
  task: Task;
  speechSupported: boolean;
  onClose: () => void;
  onSave: (t: Task) => void;
  onCreateSmart: (t: Task) => Promise<void>;
  onPostpone: (id: string) => void;
  onMoveToday: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [time, setTime] = useState(task.time || "");
  const [deadline, setDeadline] = useState(task.deadline || "");
  const [priority, setPriority] = useState<Priority>(task.priority);
  const [confirmPostpone, setConfirmPostpone] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dictating, setDictating] = useState(false);
  const [dictError, setDictError] = useState<string | null>(null);
  const sheetRecRef = useRef<any>(null);
  const titleBaseRef = useRef("");
  const isNew = task.title === "";
  const burning = isBurning(task);

  const toggleDictate = useCallback(() => {
    if (dictating) {
      try {
        sheetRecRef.current?.stop();
      } catch {
        // ignore
      }
      setDictating(false);
      return;
    }
    const SR =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;
    if (!SR) return;
    const rec = new SR();
    rec.lang = "uk-UA";
    rec.continuous = false;
    rec.interimResults = true;
    titleBaseRef.current = title ? title.trimEnd() + " " : "";
    rec.onresult = (e: any) => {
      let finalText = "";
      let interim = "";
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      setTitle(titleBaseRef.current + finalText + interim);
    };
    rec.onend = () => setDictating(false);
    rec.onerror = (e: any) => {
      setDictating(false);
      if (e?.error !== "aborted") setDictError(speechErrorText(e?.error || ""));
    };
    sheetRecRef.current = rec;
    try {
      rec.start();
      setDictating(true);
      setDictError(null);
    } catch {
      setDictating(false);
    }
  }, [dictating, title]);

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/30" onClick={onClose}>
      <div
        className="sheet w-full rounded-t-3xl bg-[#F6F5F2] p-5 pb-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-[#E8E5DF]" />
        {isNew && (
          <p className="serif mb-3 text-center text-[18px] text-[#191815]">
            Нова справа
          </p>
        )}
        <div className="relative">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Що потрібно зробити?"
            autoFocus={isNew}
            className="w-full rounded-2xl border border-[#E8E5DF] bg-white/70 p-3.5 pr-12 text-[16px] text-[#191815] placeholder-[#6E6A61] outline-none focus:border-[#C88A4E]"
          />
          {speechSupported && (
            <button
              onClick={toggleDictate}
              aria-label={dictating ? "Зупинити диктування" : "Надиктувати назву"}
              className={`absolute right-2 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full transition active:scale-95 ${
                dictating
                  ? "animate-pulse bg-[#B5793A] text-white"
                  : "bg-[#E8E5DF]/70 text-[#6E6A61]"
              }`}
            >
              <MicIcon size={18} />
            </button>
          )}
        </div>
        {dictating && (
          <p className="mt-1.5 text-center text-xs text-[#B5793A]">
            Слухаю… кажи назву справи
          </p>
        )}
        {dictError && !dictating && (
          <p className="mt-1.5 rounded-xl bg-[#F7E7E2] p-2 text-center text-xs text-[#A8402F]">
            {dictError}
          </p>
        )}
        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="min-w-0 text-xs text-[#6E6A61]">
            Час
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="mt-1 block h-12 w-full min-w-0 appearance-none rounded-2xl border border-[#E8E5DF] bg-white/70 px-3 text-[16px] text-[#191815] outline-none focus:border-[#C88A4E]"
            />
          </label>
          <label className="min-w-0 text-xs text-[#6E6A61]">
            Дедлайн
            <input
              type="date"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
              className="mt-1 block h-12 w-full min-w-0 appearance-none rounded-2xl border border-[#E8E5DF] bg-white/70 px-3 text-[16px] text-[#191815] outline-none focus:border-[#C88A4E]"
            />
          </label>
        </div>
        <div className="mt-3">
          <p className="mb-1 text-xs text-[#6E6A61]">Пріоритет</p>
          <button
            onClick={() =>
              setPriority((p) => (p === "high" ? "medium" : "high"))
            }
            className={`w-full rounded-2xl py-3 text-sm font-medium transition active:scale-[0.98] ${
              priority === "high"
                ? "bg-[#F6DDB8]/70 text-[#B5793A]"
                : "border border-[#E8E5DF] bg-white/70 text-[#6E6A61]"
            }`}
          >
            {priority === "high" ? "Важливо ✓" : "Позначити як важливу"}
          </button>
        </div>
        <button
          onClick={async () => {
            const finalTitle = title.trim() || task.title;
            if (!finalTitle || saving) return;
            const built: Task = {
              ...task,
              title: finalTitle,
              time: time || null,
              deadline: deadline || null,
              priority,
              list: priority === "high" ? "today" : task.list,
            };
            if (isNew) {
              // Нову справу пропускаємо через Нору (час/дата/пріоритет з тексту)
              setSaving(true);
              await onCreateSmart(built);
              setSaving(false);
            } else {
              onSave(built);
            }
          }}
          disabled={saving}
          className="mt-4 w-full rounded-2xl bg-[#191815] py-4 text-[16px] font-medium text-[#F6F5F2] transition active:scale-[0.98] disabled:opacity-60"
        >
          {saving ? "Нора розбирає…" : "Зберегти"}
        </button>
        {confirmPostpone ? (
          <div className="rise mt-2 rounded-2xl border border-[#E8E5DF] bg-white/70 p-3.5">
            <p className="mb-2 text-center text-sm text-[#191815]">
              Перенести на потім і зняти позначку «Важливо»?
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => onPostpone(task.id)}
                className="flex-1 rounded-2xl bg-[#191815] py-3 text-sm font-medium text-[#F6F5F2] transition active:scale-[0.98]"
              >
                Так, перенести
              </button>
              <button
                onClick={() => setConfirmPostpone(false)}
                className="flex-1 rounded-2xl border border-[#E8E5DF] py-3 text-sm text-[#6E6A61] transition active:scale-[0.98]"
              >
                Залишити
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-2 flex gap-2">
            {/* Прострочене не відкладається — воно або робиться, або отримує новий дедлайн */}
            {!isNew &&
              !burning &&
              (task.list === "today" ? (
                <button
                  onClick={() =>
                    priority === "high"
                      ? setConfirmPostpone(true)
                      : onPostpone(task.id)
                  }
                  className="flex-1 rounded-2xl border border-[#E8E5DF] py-3.5 text-sm text-[#6E6A61] transition active:scale-[0.98]"
                >
                  Відкласти на потім
                </button>
              ) : (
                <button
                  onClick={() => onMoveToday(task.id)}
                  className="flex-1 rounded-2xl border border-[#C88A4E]/50 py-3.5 text-sm font-medium text-[#B5793A] transition active:scale-[0.98]"
                >
                  Взяти в Мій день
                </button>
              ))}
            <button
              onClick={() => onDelete(task.id)}
              className="flex-1 rounded-2xl border border-[#E8E5DF] py-3.5 text-sm text-[#A8402F] transition active:scale-[0.98]"
            >
              {isNew ? "Скасувати" : "Видалити"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
