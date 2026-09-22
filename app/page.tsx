import DownwindApp from '@/components/DownwindApp';

/**
 * Decision 6c: a seeded cold open rather than an empty prompt box. The map
 * lands on real current activity and the example questions are one click, so
 * a reviewer sees the system working before typing anything — and one poor
 * first question cannot make a working system look weak.
 */
export default function Page() {
  return <DownwindApp />;
}
