import { useCallback, useEffect, useState } from 'react';
import './App.css';
import { asrClient } from './asr/asrClient';
import { findPreset } from './asr/models';
import { inspectCache, requestPersistence } from './asr/modelStore';
import { useModelState } from './asr/useModelState';
import { ModelManager } from './components/ModelManager';
import { ModelStatusPill } from './components/ModelStatusPill';
import { SongEditor } from './components/SongEditor';
import { SongList } from './components/SongList';
import { SongPractice } from './components/SongPractice';
import { TwisterList } from './components/TwisterList';
import { TwisterPanel } from './components/TwisterPanel';
import { TWISTERS } from './data/twisters';
import { loadBestScores, loadSettings, saveSettings } from './lib/settings';
import type { Settings } from './lib/settings';

type Route =
  | { page: 'home' }
  | { page: 'twister'; id: string }
  | { page: 'models' }
  | { page: 'songs' }
  | { page: 'song-new' }
  | { page: 'song'; id: string };

function parseHash(): Route {
  const hash = window.location.hash.replace(/^#\/?/, '');
  const [page, id] = hash.split('/');
  if (page === 't' && id) return { page: 'twister', id: decodeURIComponent(id) };
  if (page === 's' && id) return { page: 'song', id: decodeURIComponent(id) };
  if (page === 'songs') return id === 'new' ? { page: 'song-new' } : { page: 'songs' };
  if (page === 'models') return { page: 'models' };
  return { page: 'home' };
}

function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [best, setBest] = useState<Record<string, number>>(loadBestScores);
  const modelState = useModelState();

  useEffect(() => {
    const onHash = () => {
      setRoute(parseHash());
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Auto-load the selected model only when it is already fully saved, so a
  // first visit never starts a large download without the user asking.
  useEffect(() => {
    const initial = loadSettings();
    const preset = findPreset(initial.modelId);
    if (!preset || !initial.saveModels) return;
    let cancelled = false;
    void inspectCache([preset]).then(({ models }) => {
      if (!cancelled && models[preset.id].complete && asrClient.getState().status === 'idle') {
        asrClient.load(preset, true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      return next;
    });
  }, []);

  const loadModel = useCallback(
    (modelId: string) => {
      const preset = findPreset(modelId);
      if (!preset) return;
      updateSettings({ modelId });
      if (settings.saveModels) void requestPersistence();
      asrClient.load(preset, settings.saveModels);
    },
    [settings.saveModels, updateSettings],
  );

  const twister = route.page === 'twister' ? TWISTERS.find((t) => t.id === route.id) : undefined;

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/">
          <span className="brand-mark" aria-hidden>
            잰
          </span>
          <span>잰말놀이 발음 테스트</span>
        </a>
        <nav className="nav">
          <a href="#/" className={route.page === 'home' || route.page === 'twister' ? 'active' : ''}>
            잰말놀이
          </a>
          <a href="#/songs" className={route.page.startsWith('song') ? 'active' : ''}>
            노래
          </a>
        </nav>
        <ModelStatusPill state={modelState} />
      </header>

      <main className="content">
        {route.page === 'models' && (
          <ModelManager
            settings={settings}
            modelState={modelState}
            onLoad={loadModel}
            onChangeSettings={updateSettings}
          />
        )}
        {route.page === 'home' && <TwisterList best={best} modelState={modelState} />}
        {route.page === 'songs' && <SongList />}
        {route.page === 'song-new' && <SongEditor modelState={modelState} saveModels={settings.saveModels} />}
        {route.page === 'song' && (
          <SongPractice
            key={route.id}
            songId={route.id}
            modelState={modelState}
            selectedModelId={settings.modelId}
            saveModels={settings.saveModels}
            onLoadModel={loadModel}
          />
        )}
        {route.page === 'twister' &&
          (twister ? (
            <TwisterPanel
              key={twister.id}
              twister={twister}
              modelState={modelState}
              selectedModelId={settings.modelId}
              onLoadModel={loadModel}
              onBest={setBest}
            />
          ) : (
            <p className="empty">
              문구를 찾을 수 없어요. <a href="#/">목록으로</a>
            </p>
          ))}
      </main>

      <footer className="footer">
        모든 분석은 이 브라우저 안에서만 실행돼요. 녹음은 서버로 전송되지 않습니다.
      </footer>
    </div>
  );
}

export default App;
