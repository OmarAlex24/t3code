import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

const TICK = "5 seconds";
// Well past a busy main thread's stall, well short of a nap.
const SUSPENDED_AFTER_MS = 30_000;

/** True when a timer fired so late that the computer must have slept in between. */
export const sleptBetweenTicks = (previousMs: number, nowMs: number): boolean =>
  nowMs - previousMs >= SUSPENDED_AFTER_MS;

/**
 * Fires when the computer wakes from sleep, which no page event reports: timers stand still
 * while it sleeps and the wall clock does not. Its sockets died silently meanwhile, and their
 * piled-up retry backoff must not keep a finished run showing as working.
 */
export const computerWakeups: Stream.Stream<"application-active"> = Stream.unwrap(
  Effect.gen(function* () {
    let previous = yield* Clock.currentTimeMillis;
    return Stream.tick(TICK).pipe(
      Stream.mapEffect(() => Clock.currentTimeMillis),
      Stream.filter((now) => {
        const slept = sleptBetweenTicks(previous, now);
        previous = now;
        return slept;
      }),
      Stream.map(() => "application-active" as const),
    );
  }),
);
