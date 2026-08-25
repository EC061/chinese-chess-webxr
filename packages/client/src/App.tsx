/**
 * The shell: one persistent 3D canvas with the flat interface layered over it.
 *
 * The canvas is never unmounted — switching screens or entering a headset must
 * not throw away the WebGL context, the board textures, or the warm engine
 * workers. When an immersive session is running the flat overlay hides itself
 * and the in-scene panels take over.
 */
import { useEffect, useMemo } from 'react';
import { useStore } from './state/store.js';
import {
  AiSetupScreen, ApproveScreen, AuthScreen, GameHud, LeaderboardScreen, LinkScreen, LobbyScreen,
  MenuScreen, SettingsScreen, Toast, TopBar, TutorialScreen, useXRMode,
} from './ui/Screens.js';
import { XRApp, createStore } from './xr/XRApp.js';

export const App = () => {
  const screen = useStore((state) => state.screen);
  const boot = useStore((state) => state.boot);
  const store = useMemo(() => createStore(), []);
  const mode = useXRMode(store);
  const immersive = mode === 'immersive-vr' || mode === 'immersive-ar';

  useEffect(() => {
    void boot();
  }, [boot]);

  return (
    <div className="app" data-immersive={immersive}>
      <div className="canvas-layer">
        <XRApp store={store} />
      </div>

      {/* Unmounted rather than hidden while a session runs: the tutorial screens
          exist in both interfaces and would otherwise both drive the board. */}
      {immersive ? null : (
        <div className="overlay">
          <TopBar store={store} />
          <main style={{ minHeight: 0 }}>
            {screen === 'boot' ? <BootScreen /> : null}
            {screen === 'auth' ? <AuthScreen /> : null}
            {screen === 'link' ? <LinkScreen /> : null}
            {screen === 'approve' ? <ApproveScreen /> : null}
            {screen === 'menu' ? <MenuScreen /> : null}
            {screen === 'ai-setup' ? <AiSetupScreen /> : null}
            {screen === 'lobby' ? <LobbyScreen /> : null}
            {screen === 'tutorial' ? <TutorialScreen /> : null}
            {screen === 'leaderboard' ? <LeaderboardScreen /> : null}
            {screen === 'settings' ? <SettingsScreen /> : null}
          </main>
          {screen === 'room' || screen === 'tutorial' ? <GameHud /> : <div />}
        </div>
      )}

      {immersive ? null : <Toast />}
    </div>
  );
};

const BootScreen = () => {
  const s = useStore((state) => state.s);
  return (
    <div className="center-pane">
      <div className="card stack" style={{ textAlign: 'center' }}>
        <strong style={{ fontSize: 20 }}>{s.appTitle}</strong>
        <span className="muted">{s.appSubtitle}</span>
      </div>
    </div>
  );
};
