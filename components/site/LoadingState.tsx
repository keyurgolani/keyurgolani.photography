import styles from './LoadingState.module.css';

/**
 * The shared client-side wait: a status region on the ground whose label shows
 * only after a second, so a quick load never flashes it. No spinner, shimmer,
 * or pulse. #18 renders it behind Home's chrome on a first visit.
 */
export default function LoadingState({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" className={styles.state}>
      <span className={styles.label}>{label}</span>
    </div>
  );
}
