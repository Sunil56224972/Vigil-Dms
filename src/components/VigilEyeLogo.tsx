import React, { useEffect, useId, useRef } from 'react';
import anime from 'animejs';

const SCLERA_POLYGON =
  '184.0,643.1 190.0,638.9 196.0,632.3 202.0,624.7 208.0,618.1 214.0,613.0 220.0,608.0 226.0,603.4 232.0,598.0 238.0,592.6 244.0,587.6 250.0,583.1 256.0,579.0 262.0,575.0 268.0,571.3 274.0,567.4 280.0,563.9 286.0,560.3 292.0,557.3 298.0,554.3 304.0,551.3 310.0,548.7 316.0,546.1 322.0,543.7 328.0,541.4 334.0,539.1 340.0,537.0 346.0,535.0 352.0,533.3 358.0,531.4 364.0,529.9 370.0,528.4 376.0,527.3 382.0,526.0 388.0,524.7 394.0,523.6 400.0,522.3 406.0,521.0 412.0,521.0 418.0,520.4 424.0,519.9 430.0,519.0 436.0,518.3 442.0,518.0 448.0,518.0 454.0,518.3 460.0,519.4 466.0,520.0 472.0,520.0 478.0,520.6 484.0,521.0 490.0,520.7 496.0,521.0 502.0,522.0 508.0,523.3 514.0,524.6 520.0,525.9 526.0,527.3 532.0,528.6 538.0,530.1 544.0,531.7 550.0,533.4 556.0,535.1 562.0,537.0 568.0,539.0 574.0,541.0 580.0,543.1 586.0,545.7 592.0,548.1 598.0,550.7 604.0,553.4 610.0,556.3 616.0,558.9 622.0,561.7 628.0,565.0 634.0,568.3 640.0,571.6 646.0,575.0 652.0,578.6 658.0,582.3 664.0,586.3 670.0,590.6 676.0,594.7 682.0,599.0 688.0,603.4 694.0,607.9 700.0,612.6 706.0,617.6 712.0,623.0 718.0,629.0 724.0,635.0 730.0,641.7 732.0,639.3 732.0,635.4 726.0,642.0 720.0,649.0 714.0,655.4 708.0,660.1 702.0,665.7 696.0,670.3 690.0,674.7 684.0,678.7 678.0,682.6 672.0,686.1 666.0,689.3 660.0,692.3 654.0,695.3 648.0,697.9 642.0,700.1 636.0,702.6 630.0,705.3 624.0,708.0 618.0,710.0 612.0,711.7 606.0,713.7 600.0,715.7 594.0,717.7 588.0,719.4 582.0,721.1 576.0,722.4 570.0,723.6 564.0,724.7 558.0,726.0 552.0,727.3 546.0,728.4 540.0,729.6 534.0,730.7 528.0,731.7 522.0,732.1 516.0,733.0 510.0,733.0 504.0,733.7 498.0,734.6 492.0,735.6 486.0,736.0 480.0,736.9 474.0,737.0 468.0,737.0 462.0,737.0 456.0,737.0 450.0,737.0 444.0,737.0 438.0,737.0 432.0,737.0 426.0,737.0 420.0,736.3 414.0,735.1 408.0,734.3 402.0,734.0 396.0,734.0 390.0,734.0 384.0,734.0 378.0,733.0 372.0,731.4 366.0,730.7 360.0,729.1 354.0,727.7 348.0,726.4 342.0,725.4 336.0,724.3 330.0,723.0 324.0,721.6 318.0,720.3 312.0,718.4 306.0,716.7 300.0,714.7 294.0,712.6 288.0,710.3 282.0,708.3 276.0,706.1 270.0,703.9 264.0,701.3 258.0,698.3 252.0,695.3 246.0,692.0 240.0,688.6 234.0,685.0 228.0,681.0 222.0,676.7 216.0,671.9 210.0,666.0 204.0,660.6 198.0,654.4 192.0,647.6 186.0,639.6';

const IRIS_BASE_X = 459 - 160;
const IRIS_BASE_Y = 564 - 160;
const PUPIL_BASE_X = 459 - 48;
const PUPIL_BASE_Y = 574 - 48;

export interface VigilEyeLogoProps {
  width?: number;
  height?: number;
  alertStage?: number;
  driverGaze?: {
    active: boolean;
    faceDetected: boolean;
    gazeX: number;
    gazeY: number;
    eyesClosed: boolean;
  };
  className?: string;
  title?: string;
}

export const VigilEyeLogo: React.FC<VigilEyeLogoProps> = ({
  width = 42,
  height = 40,
  alertStage = 0,
  driverGaze,
  className = '',
  title = 'Vigil All-Seeing Ocular Sentinel',
}) => {
  const rawId = useId().replace(/[^a-zA-Z0-9]/g, '');
  const clipId = `vigil-sclera-${rawId}`;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const irisGroupRef = useRef<SVGGElement | null>(null);
  const pupilGroupRef = useRef<SVGGElement | null>(null);
  const browGroupRef = useRef<SVGGElement | null>(null);
  const blinkFillRef = useRef<SVGPathElement | null>(null);
  const blinkStrokeRef = useRef<SVGPathElement | null>(null);

  const driverGazeRef = useRef(driverGaze);
  driverGazeRef.current = driverGaze;
  const stageRef = useRef(alertStage);
  stageRef.current = alertStage;

  const blinkStateRef = useRef({ frac: 0 });
  const triggerBlinkRef = useRef<((doubleBlink?: boolean) => void) | null>(null);

  useEffect(() => {
    const pointer = {
      x: typeof window !== 'undefined' ? window.innerWidth * 0.5 : 600,
      y: typeof window !== 'undefined' ? window.innerHeight * 0.45 : 400,
      lastMoveMs: -10000,
    };

    const saccade = {
      nx: 0,
      ny: 0,
      nextAtMs: performance.now() + 1800,
    };

    // Spring state for organic, weighted ocular motion (zero robotic linear/sine drift)
    const phys = {
      gx: 0,
      gy: 0,
      vx: 0,
      vy: 0,
      pupilScale: 1,
    };

    const onPointerMove = (e: PointerEvent | MouseEvent) => {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      pointer.lastMoveMs = performance.now();
    };

    const onTouch = (e: TouchEvent) => {
      if (e.touches && e.touches.length > 0) {
        pointer.x = e.touches[0].clientX;
        pointer.y = e.touches[0].clientY;
        pointer.lastMoveMs = performance.now();
      }
    };

    let activeBlinkAnim: anime.AnimeTimelineInstance | null = null;
    let scheduledBlinkTimer: number | null = null;

    const fireBlink = (doubleBlink = false) => {
      if (activeBlinkAnim) activeBlinkAnim.pause();
      const tl = anime.timeline({ autoplay: true });
      tl.add({
        targets: blinkStateRef.current,
        frac: 1,
        duration: 105,
        easing: 'cubicBezier(0.42, 0, 0.9, 1)',
      }).add({
        targets: blinkStateRef.current,
        frac: 0,
        duration: 175,
        delay: 24,
        easing: 'cubicBezier(0.16, 1, 0.3, 1)',
      });

      if (doubleBlink) {
        tl.add({
          targets: blinkStateRef.current,
          frac: 0.95,
          duration: 90,
          delay: 55,
          easing: 'cubicBezier(0.42, 0, 0.9, 1)',
        }).add({
          targets: blinkStateRef.current,
          frac: 0,
          duration: 165,
          delay: 18,
          easing: 'cubicBezier(0.16, 1, 0.3, 1)',
        });
      }
      activeBlinkAnim = tl;
    };

    triggerBlinkRef.current = fireBlink;

    const scheduleNextBlink = () => {
      const delayMs = 3100 + Math.random() * 3600;
      scheduledBlinkTimer = window.setTimeout(() => {
        const dg = driverGazeRef.current;
        if (!(dg?.active && dg?.eyesClosed)) {
          fireBlink(Math.random() < 0.18);
        }
        scheduleNextBlink();
      }, delayMs);
    };
    scheduleNextBlink();

    const onVisibilityOrFocus = () => {
      if (document.visibilityState === 'visible') {
        saccade.nx = 0;
        saccade.ny = 0;
        fireBlink(true);
      }
    };

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('touchmove', onTouch, { passive: true });
    window.addEventListener('touchstart', onTouch, { passive: true });
    document.addEventListener('visibilitychange', onVisibilityOrFocus);
    window.addEventListener('focus', onVisibilityOrFocus);

    let rafId = 0;
    let cachedRect: DOMRect | null = null;
    let lastRectMs = -5000;

    const tick = (now: number) => {
      const el = rootRef.current;
      if (el && now - lastRectMs > 350) {
        cachedRect = el.getBoundingClientRect();
        lastRectMs = now;
      }

      let targetNx = 0;
      let targetNy = 0;
      const idleMs = now - pointer.lastMoveMs;
      const dg = driverGazeRef.current;
      const stage = stageRef.current;

      if (idleMs < 2400 && cachedRect && cachedRect.width > 0) {
        // 1. Direct Cursor / Touch Lock ("looks at you everywhere")
        const cx = cachedRect.left + cachedRect.width * 0.5;
        const cy = cachedRect.top + cachedRect.height * 0.56;
        const dx = pointer.x - cx;
        const dy = pointer.y - cy;
        const dist = Math.hypot(dx, dy);
        if (dist > 2) {
          const pull = Math.tanh(dist / 240);
          targetNx = (dx / dist) * pull;
          targetNy = (dy / dist) * pull;
        }
      } else if (dg?.active && dg.faceDetected) {
        // 2. Live Driver Webcam Ocular Coupling ("anytime" — mirrors driver gaze)
        targetNx = Math.max(-1, Math.min(1, dg.gazeX * 1.35));
        targetNy = Math.max(-1, Math.min(1, dg.gazeY * 1.35));
      } else {
        // 3. Lifelike Human Ballistic Saccades ("always watching" — quick glances + direct eye contact)
        if (now >= saccade.nextAtMs) {
          const directEyeContact = Math.random() < 0.38;
          if (directEyeContact) {
            // Look straight out of the screen directly at the viewer
            saccade.nx = (Math.random() - 0.5) * 0.08;
            saccade.ny = (Math.random() - 0.5) * 0.06;
            saccade.nextAtMs = now + 2200 + Math.random() * 2200;
          } else {
            const angle = Math.random() * Math.PI * 2;
            const mag = stage >= 2 ? 0.65 + Math.random() * 0.32 : 0.28 + Math.random() * 0.58;
            saccade.nx = Math.cos(angle) * mag;
            saccade.ny = Math.sin(angle) * mag * 0.72;
            saccade.nextAtMs =
              now + (stage >= 3 ? 650 + Math.random() * 650 : 1600 + Math.random() * 2600);
          }
        }
        targetNx = saccade.nx;
        targetNy = saccade.ny;
      }

      // Subtle biological micro-tremor so the eye never freezes like a dead graphic
      const microX = Math.sin(now * 0.0047) * 1.1 + Math.cos(now * 0.0113) * 0.6;
      const microY = Math.cos(now * 0.0053) * 0.8;

      const maxRx = 94;
      const maxRy = targetNy < 0 ? 28 : 42;
      const goalX = targetNx * maxRx + microX;
      const goalY = targetNy * maxRy + microY;

      // Critically-damped ocular muscle spring
      const stiffness = idleMs < 2400 ? 0.22 : 0.16;
      const damping = 0.72;
      phys.vx = (phys.vx + (goalX - phys.gx) * stiffness) * damping;
      phys.vy = (phys.vy + (goalY - phys.gy) * stiffness) * damping;
      phys.gx += phys.vx;
      phys.gy += phys.vy;

      const targetPupilScale = stage >= 3 ? 1.14 : idleMs < 600 ? 1.04 : 0.98;
      phys.pupilScale += (targetPupilScale - phys.pupilScale) * 0.12;

      if (irisGroupRef.current) {
        irisGroupRef.current.setAttribute(
          'transform',
          `translate(${phys.gx.toFixed(2)}, ${phys.gy.toFixed(2)})`
        );
      }

      if (pupilGroupRef.current) {
        // 1.24x corneal parallax + subtle dilation around pupil center (459, 574)
        const px = phys.gx * 1.24;
        const py = phys.gy * 1.22;
        const s = phys.pupilScale.toFixed(3);
        pupilGroupRef.current.setAttribute(
          'transform',
          `translate(${px.toFixed(2)}, ${py.toFixed(2)}) translate(459, 574) scale(${s}) translate(-459, -574)`
        );
      }

      // Eyelid blink + sympathetic upper brow & 11-ray movement
      const driverClosedFrac = dg?.active && dg.eyesClosed ? 0.92 : 0;
      const bFrac = Math.max(blinkStateRef.current.frac, driverClosedFrac);

      if (browGroupRef.current) {
        const browY = bFrac * 22 + phys.gy * 0.15;
        const browRot = phys.gx * 0.014;
        browGroupRef.current.setAttribute(
          'transform',
          `translate(0, ${browY.toFixed(2)}) rotate(${browRot.toFixed(2)}, 458, 520)`
        );
      }

      if (blinkFillRef.current && blinkStrokeRef.current) {
        if (bFrac > 0.01) {
          const ctrlY = (396 + bFrac * 468).toFixed(1);
          const edgeD = `M 178,641 Q 458,${ctrlY} 738,639`;
          blinkFillRef.current.setAttribute('d', `${edgeD} L 745,495 L 172,495 Z`);
          blinkStrokeRef.current.setAttribute('d', edgeD);
          blinkFillRef.current.style.display = '';
          blinkStrokeRef.current.style.display = '';
        } else {
          blinkFillRef.current.style.display = 'none';
          blinkStrokeRef.current.style.display = 'none';
        }
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafId);
      if (scheduledBlinkTimer) clearTimeout(scheduledBlinkTimer);
      if (activeBlinkAnim) activeBlinkAnim.pause();
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('touchmove', onTouch);
      window.removeEventListener('touchstart', onTouch);
      document.removeEventListener('visibilitychange', onVisibilityOrFocus);
      window.removeEventListener('focus', onVisibilityOrFocus);
    };
  }, []);

  return (
    <div
      ref={rootRef}
      className={`dms-eye-emblem ${alertStage >= 3 ? 'stage-crit' : ''} ${className}`}
      style={{ width, height }}
      title={title}
      onClick={() => triggerBlinkRef.current?.(true)}
    >
      <svg
        viewBox="35 20 810 815"
        width="100%"
        height="100%"
        aria-label={title}
        style={{ display: 'block', overflow: 'visible' }}
      >
        <defs>
          <clipPath id={clipId}>
            <polygon points={SCLERA_POLYGON} />
          </clipPath>
        </defs>

        {/* Sclera interior + Clipped 360-deg Hand-Hatched Iris, Parallax Diamond Pupil & Curved Eyelid Blink */}
        <g clipPath={`url(#${clipId})`}>
          <polygon points={SCLERA_POLYGON} fill="#FAF4F2" />

          <g ref={irisGroupRef} style={{ willChange: 'transform' }}>
            <image
              href="/brand/eye-iris-360.png"
              x={IRIS_BASE_X}
              y={IRIS_BASE_Y}
              width={320}
              height={320}
            />
          </g>

          <g ref={pupilGroupRef} style={{ willChange: 'transform' }}>
            <image
              href="/brand/eye-pupil.png"
              x={PUPIL_BASE_X}
              y={PUPIL_BASE_Y}
              width={96}
              height={96}
            />
          </g>

          <path ref={blinkFillRef} fill="#F5EBE9" style={{ display: 'none' }} />
          <path
            ref={blinkStrokeRef}
            fill="none"
            stroke="#11100F"
            strokeWidth={10.5}
            strokeLinecap="round"
            style={{ display: 'none' }}
          />
        </g>

        {/* Hand-Inked Almond Eyelids + 5 Under-Eye Hollow Rings */}
        <image href="/brand/eye-lids-dots.png" x={0} y={0} width={880} height={850} />

        {/* Hand-Inked Upper Brow Arch + 11 Radiating Lashes with Sympathetic Follow-Through */}
        <g ref={browGroupRef} style={{ willChange: 'transform' }}>
          <image href="/brand/eye-brow-lashes.png" x={0} y={0} width={880} height={850} />
        </g>
      </svg>
    </div>
  );
};
