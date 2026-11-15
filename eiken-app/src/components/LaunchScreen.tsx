import { useEffect, useRef, useState } from 'react';
import { AlphaCinematicClip, ALPHA_CINEMATIC_CLIPS } from './AlphaCinematicClip';
import { TitleBgmMuteButton, TITLE_SCREEN_BGM_SRC, useLaunchTitleBgm } from './TitleBgmControl';
import { ArrowRight, BookHeart, Headphones, PenLine, Repeat2, Swords } from 'lucide-react';
import { PhilosophyPage } from './PhilosophyPage';
import { useGrowthProgress } from '../hooks/useGrowthProgress';
import { equippedPoseSrc } from '../battle/core/growth';
import { TobiraAccessories } from '../battle/ui/TobiraAccessories';
import { auth, FIREBASE_CONFIGURED } from '../firebase';
import './launch-screen.css';
import { fadeOutLaunchSfx, launchCueSchedule, playLaunchSfx, preloadLaunchSfx, type LaunchSfx } from '../battle/audio/launchSfx';
import { resumeSharedAudio } from '../battle/audio/sharedAudioContext';
import { readAudioPreferences } from '../battle/audio/audioPreferences';

const EIKEN_DISCLAIMER = '英検®は公益財団法人 日本英語検定協会の登録商標です。本アプリは同協会の承認・推奨を受けたものではありません。問題は独自制作です。';

/**
 * タイトル画面（2026-11-15 英検版：とびら君＆カギノスケ 透過演出＋ループBGM対応）。
 *
 * - 横向き／PC（orientation: landscape かつ min-width: 768px）＝ ② title_duo_landscape（15秒）
 * - 縦向き／スマホ（それ以外）＝ ③ title_duo_portrait（15秒）
 * - キャラと邪魔にならない発光だけを透過合成し、終了時は最終コマと 100% 同じ位置・大きさ・ポーズの
 *   2人透過プレート（title_duo_*-end.webp）＋微細な呼吸・キラキラのアイドルループへクロスフェード（ポンと切り替わらない）。
 * - いつでも「演出をスキップ」で即座に待機状態へ移行可能。
 * - BGM は④の音声から抽出したループ音源（/bgm/title_intro_bgm.mp3）を初回ユーザー操作後に控えめな音量でループ再生し、
 *   右上のミュート切替ボタンで ON/OFF できる。
 */
type Phase = 'intro' | 'crossfade' | 'done';

const LANDSCAPE_QUERY = '(orientation: landscape) and (min-width: 768px)';

function useLandscapeTitle(): boolean {
  const [isLandscape, setIsLandscape] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia(LANDSCAPE_QUERY).matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(LANDSCAPE_QUERY);
    const onChange = () => setIsLandscape(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return isLandscape;
}

export function LaunchScreen({ onStart }: {
  /** 2026-10-19 ゲスト入口は廃止（ログイン必須）。未ログインなら次にログイン画面が出る */
  onStart: () => void;
}) {
  const { progress } = useGrowthProgress();
  const isLandscape = useLandscapeTitle();
  const titleClip = isLandscape ? ALPHA_CINEMATIC_CLIPS.titleLandscape : ALPHA_CINEMATIC_CLIPS.titlePortrait;

  const [phase, setPhase] = useState<Phase>('intro');
  const [gate, setGate] = useState<'emblem' | 'title' | 'philosophy'>('emblem');
  const [emblemPhase, setEmblemPhase] = useState<'in' | 'hold' | 'out'>('in');
  const [emblemSkipped, setEmblemSkipped] = useState(false);

  const { audioRef: titleBgmRef, muted: titleBgmMuted, toggleMute: toggleTitleBgm } = useLaunchTitleBgm(gate === 'title');

  const sfxTimers = useRef<number[]>([]);
  const bloomDone = useRef(false);
  const skipRequested = useRef(false);
  const cue = (name: LaunchSfx) => { playLaunchSfx(name, readAudioPreferences().volume); };
  const clearSfxTimers = () => { sfxTimers.current.forEach(t => window.clearTimeout(t)); sfxTimers.current = []; };

  useEffect(() => {
    if (gate !== 'emblem') return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const at = reduced ? { hold: 0, out: 900, title: 1100 } : { hold: 700, out: 2500, title: 3400 };
    let alive = true;
    const visualTimers: number[] = [];
    void preloadLaunchSfx().then(() => {
      if (!alive || skipRequested.current) return;
      resumeSharedAudio();
      const t0 = performance.now();
      visualTimers.push(
        window.setTimeout(() => setEmblemPhase(p => (p === 'in' ? 'hold' : p)), at.hold),
        window.setTimeout(() => setEmblemPhase('out'), at.out),
        window.setTimeout(() => setGate(g => (g === 'emblem' ? 'title' : g)), at.title),
      );
      for (const c of launchCueSchedule(at.title)) {
        if (c.name === 'title_bloom') continue;
        const wait = c.at - (performance.now() - t0);
        if (wait < -500) continue;
        sfxTimers.current.push(window.setTimeout(() => cue(c.name), Math.max(0, wait)));
      }
    });
    return () => { alive = false; visualTimers.forEach(t => window.clearTimeout(t)); clearSfxTimers(); };
  }, [gate]);

  useEffect(() => {
    if (gate !== 'title' || bloomDone.current) return;
    bloomDone.current = true;
    let alive = true;
    void preloadLaunchSfx().then(() => {
      if (!alive) return;
      resumeSharedAudio();
      cue('title_bloom');
    });
    return () => { alive = false; };
  }, [gate]);

  useEffect(() => { if (gate === 'philosophy') fadeOutLaunchSfx(); }, [gate]);
  useEffect(() => () => fadeOutLaunchSfx(), []);

  const skipEmblem = () => {
    if (emblemPhase === 'out') return;
    skipRequested.current = true;
    setEmblemSkipped(true); setEmblemPhase('out');
    clearSfxTimers(); resumeSharedAudio();
    void preloadLaunchSfx().then(() => {
      resumeSharedAudio();
      window.setTimeout(() => setGate(g => (g === 'emblem' ? 'title' : g)), 450);
    });
  };

  const [played, setPlayed] = useState(false);
  const [walkReady, setWalkReady] = useState(false);

  const lastOrientation = useRef(isLandscape);
  useEffect(() => {
    if (lastOrientation.current === isLandscape) return;
    lastOrientation.current = isLandscape;
    if (phase === 'intro') setPlayed(false);
  }, [isLandscape, phase]);

  useEffect(() => {
    if (phase !== 'crossfade') return;
    const t = setTimeout(() => setPhase('done'), 420);
    return () => clearTimeout(t);
  }, [phase]);

  const finishIntro = () => setPhase(p => (p === 'intro' ? (played ? 'crossfade' : 'done') : p));
  const walk = phase === 'done' && !played;

  useEffect(() => {
    if (gate !== 'title') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      const t = e.target as HTMLElement | null;
      if (t && t.closest('button, a, input, textarea, select, [contenteditable]')) return;
      e.preventDefault();
      enter();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const enter = () => onStart();

  return (
    <>
      <audio ref={titleBgmRef} src={TITLE_SCREEN_BGM_SRC} loop preload="auto" playsInline data-title-screen-bgm="" />
      {gate === 'emblem' ? (
        <main className="launch-emblem" data-phase={emblemPhase} data-skip={emblemSkipped || undefined} aria-label={`マナトビ 起動エンブレム（タップで進む）。${EIKEN_DISCLAIMER}`} role="button" tabIndex={0} onClick={skipEmblem} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); skipEmblem(); } }}><div className="launch-emblem-inner"><img className="launch-emblem-applogo" src="/brand/app-icon-logo.webp" alt="マナトビ" width={640} height={640}/><h1>聞いて、解いて、<br/>競って、<em>これ1本</em>で。</h1></div><p className="launch-emblem-disclaimer">{EIKEN_DISCLAIMER}</p></main>
      ) : gate === 'philosophy' ? (
        <PhilosophyPage onBack={() => setGate('title')} />
      ) : (
        <main className="launch-screen" aria-label="マナトビ タイトル画面" data-launch-screen data-orientation={isLandscape ? 'landscape' : 'portrait'}>
          <TitleBgmMuteButton muted={titleBgmMuted} onToggle={toggleTitleBgm} />
          <div className="launch-content">
            <h1 className="launch-brand"><img src="/brand/manatobi-logo.webp" width={1008} height={321} alt="マナトビ" fetchPriority="high" /></h1>
            <div className="launch-stage" data-phase={phase} aria-label="とびら君とカギノスケの登場演出">
              <div className={`launch-box ${isLandscape ? 'is-landscape' : 'is-portrait'}`}>
                <div className="launch-scene" aria-hidden="true">
                  <div className="launch-duo-aura" />
                  <div className="launch-duo-ground" />
                  <div className="launch-sparkles"><i /><i /><i /><i /><i /><i /></div>
                  {played ? (
                    <div className="launch-duo-idle">
                      <img
                        className="launch-duo-plate launch-equipped-pose"
                        src={titleClip.endPlate}
                        alt=""
                        width={titleClip.width}
                        height={titleClip.height}
                        draggable={false}
                      />
                    </div>
                  ) : (
                    <div className={`launch-arrival ${walk && walkReady ? 'walk-ready' : ''} ${!walk ? 'is-idle' : ''}`}>
                      <div className="launch-gait">
                        <img className="launch-walking-pose" src="/mascots/walking.webp" alt="" draggable={false} onLoad={() => setWalkReady(true)} />
                        <img className="launch-equipped-pose" src={progress ? equippedPoseSrc(progress) : '/mascots/basic.webp'} alt="" draggable={false} />
                        {progress && <TobiraAccessories progress={progress} />}
                      </div>
                    </div>
                  )}
                </div>
                {phase !== 'done' && (
                  <AlphaCinematicClip
                    clip={titleClip}
                    hold
                    eager
                    skippable
                    fadeInMs={420}
                    label="とびら君とカギノスケの登場動画"
                    onActiveChange={active => { if (active) setPlayed(true); }}
                    onComplete={finishIntro}
                  />
                )}
              </div>
            </div>
            <p className="launch-copy">聞いて、解いて、<br className="launch-copy-break" />競って、<em>これ1本</em>で。</p>
            <p className="launch-lead">英検5級〜準1級のリスニング・読解・語彙を級別に練習。<br />単語帳・復習・3級以上の英作文も、ひとつのアプリで。</p>
            <ul className="launch-chips" aria-label="できること">
              <li><PenLine size={16} aria-hidden="true" /><span><b>演習</b><small>級別の独自問題で重点練習</small></span></li>
              <li><Repeat2 size={16} aria-hidden="true" /><span><b>復習</b><small>解説・和訳と間違えた語を確認</small></span></li>
              <li><Swords size={16} aria-hidden="true" /><span><b>オンライン対戦</b><small>友だち・全国・AI と</small></span></li>
            </ul>
            <div className="launch-actions">
              <p className="launch-countdown-mini"><Headphones size={16} aria-hidden="true" />英検 <strong>5級〜準1級</strong><small>1級は準備中</small></p>
              <button type="button" className="launch-start mt-btn mt-btn-accent" onClick={() => { fadeOutLaunchSfx(); enter(); }}><Headphones size={20} aria-hidden="true" />はじめる<ArrowRight size={20} aria-hidden="true" /></button>
              <p className="launch-note">{auth.currentUser ? '学習のつづきから始まります' : FIREBASE_CONFIGURED ? 'ログインして記録を同期、または端末で練習できます' : 'この端末に記録を保存して練習できます'}</p>
              <button type="button" className="launch-philosophy" data-open-philosophy onClick={() => setGate('philosophy')}><BookHeart size={16} aria-hidden="true" />学びの扉 ～私達に出来ることを～</button>
              <p className="launch-kbd" aria-hidden="true"><kbd>Enter</kbd> ではじめる</p>
            </div>
          </div>
        </main>
      )}
    </>
  );
}
