'use client';

import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Pause, Play } from 'lucide-react';
import { StepPreview } from '@/features/landing/how-it-works/step-preview';
import styles from '@/features/landing/how-it-works.module.css';

const steps = [
  {
    id: 'basket',
    title: 'Build your basket',
    description: 'Choose eligible assets across your wallets and chains.',
  },
  {
    id: 'borrow',
    title: 'Borrow USDC',
    description:
      'Review your terms, lock your collateral and receive USDC on NEAR.',
  },
  {
    id: 'release',
    title: 'Repay and release',
    description:
      'Repay your loan, then release your remaining collateral to your wallets.',
  },
] as const;

export function HowItWorks() {
  const [selected, setSelected] = useState(0);
  const [paused, setPaused] = useState(false);
  const section = useRef<HTMLElement>(null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    const element = section.current;
    if (!element || paused) return;

    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let inView = false;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const sync = () => {
      clearTimeout(timer);
      if (
        !disposed &&
        inView &&
        !document.hidden &&
        !motion.matches &&
        !element.querySelector(':focus-visible')
      ) {
        timer = setTimeout(
          () => setSelected((current) => (current + 1) % steps.length),
          5000,
        );
      }
    };

    const observer = new IntersectionObserver(
      ([entry]) => {
        inView = Boolean(
          entry?.isIntersecting && entry.intersectionRatio >= 0.25,
        );
        sync();
      },
      { threshold: 0.25 },
    );
    const onBlur = () => queueMicrotask(sync);

    observer.observe(element);
    motion.addEventListener('change', sync);
    document.addEventListener('visibilitychange', sync);
    element.addEventListener('focusin', sync);
    element.addEventListener('focusout', onBlur);

    return () => {
      disposed = true;
      clearTimeout(timer);
      observer.disconnect();
      motion.removeEventListener('change', sync);
      document.removeEventListener('visibilitychange', sync);
      element.removeEventListener('focusin', sync);
      element.removeEventListener('focusout', onBlur);
    };
  }, [paused, selected]);

  function navigateSteps(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    let next: number;

    switch (event.key) {
      case 'ArrowDown':
        next = (index + 1) % steps.length;
        break;
      case 'ArrowUp':
        next = (index + steps.length - 1) % steps.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = steps.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    setSelected(next);
    tabs.current[next]?.focus();
  }

  return (
    <section
      ref={section}
      id="how-it-works"
      className={`container ${styles.section}`}
      aria-labelledby="how-it-works-title"
    >
      <div className={styles.content}>
        <div className={styles.heading}>
          <h2 id="how-it-works-title" className="section-heading">
            How it works.
          </h2>
          <button
            className={styles.playback}
            type="button"
            aria-label={paused ? 'Play step animation' : 'Pause step animation'}
            aria-pressed={paused}
            onClick={() => setPaused((current) => !current)}
          >
            {paused ? <Play size={16} /> : <Pause size={16} />}
          </button>
        </div>
        <div
          className={styles.steps}
          role="tablist"
          aria-label="Borrowing with Kanso"
          aria-orientation="vertical"
        >
          {steps.map((step, index) => (
            <button
              key={step.id}
              ref={(element) => {
                tabs.current[index] = element;
              }}
              id={`step-${step.id}`}
              className={styles.step}
              type="button"
              role="tab"
              aria-selected={selected === index}
              aria-controls={`preview-${step.id}`}
              tabIndex={selected === index ? 0 : -1}
              onClick={() => setSelected(index)}
              onKeyDown={(event) => navigateSteps(event, index)}
            >
              <span className={styles.number} aria-hidden="true">
                0{index + 1}
              </span>
              <span className={styles.copy}>
                <span className={styles.title}>{step.title}</span>
                <span className={styles.description}>{step.description}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className={styles.visual}>
        {steps.map((step, index) => (
          <div
            key={step.id}
            id={`preview-${step.id}`}
            className={styles.panel}
            role="tabpanel"
            aria-labelledby={`step-${step.id}`}
            tabIndex={0}
            hidden={selected !== index}
          >
            {selected === index && <StepPreview stage={step.id} />}
          </div>
        ))}
      </div>
    </section>
  );
}
