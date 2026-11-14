import { useState } from 'react';
import type { ModelState } from '../asr/asrClient';
import { LANGUAGES } from '../data/languages';
import { LEVEL_LABEL, TWISTERS } from '../data/twisters';

interface Props {
  best: Record<string, number>;
  modelState: ModelState;
}

const LANG_KEY = 'pronunciation-test:twister-language';

function loadLanguage(): string {
  try {
    const v = localStorage.getItem(LANG_KEY);
    return LANGUAGES.some((l) => l.code === v) ? v! : 'ko';
  } catch {
    return 'ko';
  }
}

const HINTS: Record<string, string> = {
  ko: '한글은 초성·중성·종성을 따로 비교해서 비슷하게 발음하면 부분 점수를 받아요.',
  en: '영어는 철자 단위로 비교해요. 대소문자와 문장부호는 무시해요.',
  ja: '일본어는 쓰인 글자 그대로 비교해요. 히라가나·가타카나 차이는 무시하지만, 한자를 가나로 받아 적으면 다른 글자로 봐요.',
};

export function TwisterList({ best, modelState }: Props) {
  const [language, setLanguage] = useState(loadLanguage);

  const choose = (code: string) => {
    setLanguage(code);
    try {
      localStorage.setItem(LANG_KEY, code);
    } catch {
      // Not persisted; the choice still applies for this visit.
    }
  };

  return (
    <section>
      <div className="hero">
        <h1>잰말놀이로 발음을 점검해 보세요</h1>
        <p>
          문구를 고르고 소리 내어 읽으면, 브라우저 안의 음성 인식 모델이 글자마다 어떻게 들렸는지와 정확도를
          알려줘요.
        </p>
        {modelState.status !== 'ready' && modelState.status !== 'loading' && (
          <a className="button button-primary" href="#/models">
            먼저 음성 인식 모델 준비하기
          </a>
        )}
      </div>

      <div className="filter-chips" role="tablist" aria-label="언어">
        {LANGUAGES.map((l) => (
          <button
            key={l.code}
            role="tab"
            aria-selected={language === l.code}
            className={`chip ${language === l.code ? 'active' : ''}`}
            onClick={() => choose(l.code)}
          >
            {l.label}
          </button>
        ))}
      </div>
      <p className="muted small">{HINTS[language]}</p>

      <ul className="card-grid">
        {TWISTERS.filter((t) => t.language === language).map((t) => (
          <li key={t.id}>
            <a className="card" href={`#/t/${t.id}`}>
              <div className="card-head">
                <span className={`level level-${t.level}`}>{LEVEL_LABEL[t.level]}</span>
                {t.id in best && <span className="best">최고 {best[t.id].toFixed(0)}점</span>}
              </div>
              <h2>{t.title}</h2>
              <p lang={t.language}>{t.text}</p>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
