import type { ModelState } from '../asr/asrClient';
import { LEVEL_LABEL, TWISTERS } from '../data/twisters';

interface Props {
  best: Record<string, number>;
  modelState: ModelState;
}

export function TwisterList({ best, modelState }: Props) {
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

      <ul className="card-grid">
        {TWISTERS.map((t) => (
          <li key={t.id}>
            <a className="card" href={`#/t/${t.id}`}>
              <div className="card-head">
                <span className={`level level-${t.level}`}>{LEVEL_LABEL[t.level]}</span>
                {t.id in best && <span className="best">최고 {best[t.id].toFixed(0)}점</span>}
              </div>
              <h2>{t.title}</h2>
              <p>{t.text}</p>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
