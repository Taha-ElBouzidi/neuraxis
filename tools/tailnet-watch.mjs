// Binds every tailnet address as it appears, not only the ones present at startup.
//
// 2026-09-16, the first real reboot of SERVER: the brain server started at logon while Tailscale
// still had no address, read the interface list once, and served loopback only until it was
// restarted by hand. Every other machine lost the brain and the local health check stayed green.
// Tailscale can take minutes to come up, and it restarts itself on every update.
//
// EVENTS, NOT A TIMER (2026-11-05, the owner's timers-to-events review, item 3). The list used to be read every 15 s.
// Now it is read at start and whenever sweep() is called: the brain server calls it from POST /tailnet/sweep, which
// the task HavokTailnetUp fires on Windows' "network connected" event (NetworkProfile 10000, logged with the name
// Tailscale when the tailnet comes up). intervalMs > 0 keeps the old timer for a machine without that task.
//
// bind() is called once per address. forget() lets a listener that failed be tried again the next
// time that address is present. sweep() returns the addresses bound by that call.
export function watchTailnet({ list, bind, intervalMs = 0 }) {
  const seen = new Set();
  const sweep = () => {
    const bound = [];
    for (const a of list()) {
      if (seen.has(a)) continue;
      seen.add(a);
      bind(a);
      bound.push(a);
    }
    return bound;
  };
  sweep();
  const timer = intervalMs > 0 ? setInterval(sweep, intervalMs) : null;
  return {
    sweep,
    known: () => [...seen],
    stop() { if (timer) clearInterval(timer); },
    forget(a) { seen.delete(a); },
  };
}
