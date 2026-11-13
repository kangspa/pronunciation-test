export interface Twister {
  id: string;
  title: string;
  text: string;
  // 1 = 쉬움, 2 = 보통, 3 = 어려움
  level: 1 | 2 | 3;
  language: string;
}

export const TWISTERS: Twister[] = [
  { id: 'desk', title: '철수 책상', text: '철수 책상 철 책상', level: 1, language: 'ko' },
  { id: 'chanson', title: '샹송 쇼', text: '신진 샹송 가수의 신춘 샹송 쇼', level: 1, language: 'ko' },
  {
    id: 'soy-sauce',
    title: '간장 공장',
    text: '간장 공장 공장장은 강 공장장이고 된장 공장 공장장은 장 공장장이다',
    level: 2,
    language: 'ko',
  },
  { id: 'bean-pod', title: '콩깍지', text: '들의 콩깍지는 깐 콩깍지인가 안 깐 콩깍지인가', level: 2, language: 'ko' },
  {
    id: 'tailor',
    title: '양장점',
    text: '한양 양장점 옆 한영 양장점 한영 양장점 옆 한양 양장점',
    level: 2,
    language: 'ko',
  },
  { id: 'july', title: '칠순 잔칫날', text: '칠월 칠일은 평창 친구 친정 칠순 잔칫날', level: 2, language: 'ko' },
  {
    id: 'uniform',
    title: '고려고 교복',
    text: '고려고 교복은 고급 교복이고 고려고 교복은 고급 원단을 사용했다',
    level: 2,
    language: 'ko',
  },
  { id: 'can', title: '깡통', text: '상표 붙인 큰 깡통은 깐 깡통인가 안 깐 깡통인가', level: 2, language: 'ko' },
  {
    id: 'giraffe',
    title: '기린 그림',
    text: '내가 그린 기린 그림은 긴 기린 그림이고 네가 그린 기린 그림은 안 긴 기린 그림이다',
    level: 3,
    language: 'ko',
  },
  {
    id: 'doctor',
    title: '법학박사',
    text: '저기 계신 저 분이 박 법학박사이고 여기 계신 이 분이 백 법학박사이다',
    level: 3,
    language: 'ko',
  },
  { id: 'bars', title: '쇠창살', text: '경찰청 쇠창살 외철창살 검찰청 쇠창살 쌍철창살', level: 3, language: 'ko' },
  { id: 'patent', title: '허가과장', text: '서울특별시 특허허가과 허가과장 허과장', level: 3, language: 'ko' },
  {
    id: 'porridge',
    title: '팥죽 콩죽',
    text: '앞집 팥죽은 붉은 팥 풋팥죽이고 뒷집 콩죽은 햇콩 단콩 콩죽',
    level: 3,
    language: 'ko',
  },
];

export const LEVEL_LABEL: Record<Twister['level'], string> = { 1: '쉬움', 2: '보통', 3: '어려움' };
