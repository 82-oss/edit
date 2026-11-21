import type { ShareStep, Sharing } from "./types";
import { Icon } from "./ui";
import { overallLine, stepName, stepRight, stepShare } from "./share-steps";

/**
 * A script share while it runs, as the edit's Export dialog shows one (Sphe,
 * Nov 22, the mock's second state): one number with its time left and one
 * bar, then each step on its own line, done with how long it took, under way
 * with its own bar, waiting with what it will send. Every figure is the
 * server's (writer/reviews.ts shareState); a step it can't count says how
 * long it has run instead. Done, the same list says what each took.
 */
export function ShareSteps({ steps, version, durationMs }: { steps: ShareStep[]; version?: number; durationMs?: number }) {
  return (
    <ol className="share-steps" aria-label="Share steps">
      {steps.map((step) => {
        const share = stepShare(step);
        return (
          <li key={step.kind} data-state={step.state}>
            <span className="step-line">
              <span className="step-dot" aria-hidden>
                {step.state === "done" && <Icon name="check" size={10} />}
              </span>
              <span className="step-name">{stepName(step, { version, durationMs })}</span>
              <span className="step-right tabular">{stepRight(step)}</span>
            </span>
            {share !== null && (
              <span className="step-bar" aria-hidden>
                <i style={{ width: `${Math.round(share * 100)}%` }} />
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** The share under way: its overall number, when it has one, over its steps. */
export function ShareRunning({ sharing, durationMs }: { sharing: Sharing; durationMs?: number }) {
  const { percent, left } = overallLine(sharing);
  return (
    <div className="share-run">
      {percent !== null && (
        <>
          <div className="share-big">
            <span className="pct tabular">{percent}%</span>
            {left && <span className="left">{left}</span>}
          </div>
          <div className="share-bar" aria-hidden>
            <i style={{ width: `${percent}%` }} />
          </div>
        </>
      )}
      {(sharing.steps?.length ?? 0) > 0 && <ShareSteps steps={sharing.steps!} version={sharing.version} durationMs={durationMs} />}
    </div>
  );
}
