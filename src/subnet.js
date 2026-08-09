const QUESTION_WEIGHTS = {
  mask: 100,
  totalHosts: 100,
  usableHosts: 120,
  fullRange: 140,
  networkId: 160,
  broadcast: 160,
  gateway: 140,
  usableRange: 180,
  groupCount: 120,
  groupNumber: 140
};

const DIFFICULTY = {
  easy:   { label: "사이더 24이상",        min: 24, max: 30, factor: 1.0 },
  medium: { label: "사이더 24미만 16이상", min: 16, max: 23, factor: 3.0 },
  hard:   { label: "사이더 16미만",        min: 8,  max: 15, factor: 6.0 },
  random: { label: "전체 랜덤 (사이더 8~30)", min: 8, max: 30, factor: 1.0 },
  custom: { label: "직접 범위 지정",       min: 8,  max: 30, factor: 1.0 }
};

function ipToInt(ip) {
  const parts = String(ip).trim().split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    throw new Error(`Invalid IPv4 address: ${ip}`);
  }
  return parts.reduce((acc, part) => ((acc << 8) | part) >>> 0, 0) >>> 0;
}

function intToIp(value) {
  const unsigned = value >>> 0;
  return [
    (unsigned >>> 24) & 255,
    (unsigned >>> 16) & 255,
    (unsigned >>> 8) & 255,
    unsigned & 255
  ].join(".");
}

function cidrToMask(cidr) {
  if (!Number.isInteger(cidr) || cidr < 0 || cidr > 32) {
    throw new Error(`Invalid CIDR: ${cidr}`);
  }
  const mask = cidr === 0 ? 0 : (0xffffffff << (32 - cidr)) >>> 0;
  return intToIp(mask);
}

function subnetInfo(ip, cidr) {
  const ipInt = ipToInt(ip);
  const maskInt = cidr === 0 ? 0 : (0xffffffff << (32 - cidr)) >>> 0;
  const networkInt = (ipInt & maskInt) >>> 0;
  const totalAddresses = 2 ** (32 - cidr);
  const broadcastInt = (networkInt + totalAddresses - 1) >>> 0;
  const gatewayInt = Math.max(networkInt + 1, broadcastInt - 1) >>> 0;
  const hostStartInt = Math.min(networkInt + 1, broadcastInt) >>> 0;
  const hostEndWithoutGatewayInt = Math.max(hostStartInt, gatewayInt - 1) >>> 0;
  const varyingOctetIndex = Math.min(3, Math.floor(cidr / 8));
  const bitsInVaryingOctet = cidr % 8;
  const blockSize = bitsInVaryingOctet === 0 ? 256 : 2 ** (8 - bitsInVaryingOctet);
  const octets = intToIp(ipInt).split(".").map(Number);
  const groupCount = Math.max(1, Math.floor(256 / blockSize));
  const groupNumber = Math.floor(octets[varyingOctetIndex] / blockSize);
  const groupStart = groupNumber * blockSize;
  const groupEnd = groupStart + blockSize - 1;

  return {
    ip: intToIp(ipInt),
    cidr,
    mask: cidrToMask(cidr),
    totalAddresses,
    usableHostCount: Math.max(0, totalAddresses - 3),
    networkId: intToIp(networkInt),
    broadcast: intToIp(broadcastInt),
    gateway: intToIp(gatewayInt),
    fullRange: `${intToIp(networkInt)} ~ ${intToIp(broadcastInt)}`,
    usableRange: `${intToIp(hostStartInt)} ~ ${intToIp(hostEndWithoutGatewayInt)}`,
    groupCount,
    groupNumber,
    groupRange: `${groupStart} ~ ${groupEnd}`,
    blockSize,
    varyingOctetIndex
  };
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateIp(cidr) {
  const first = randomInt(10, 223);
  const second = randomInt(0, 255);
  const third = randomInt(0, 255);
  const fourth = cidr >= 24 ? randomInt(1, 253) : randomInt(1, 254);
  return `${first}.${second}.${third}.${fourth}`;
}

function pickCidr(mode = "easy", options = {}) {
  if (mode === "custom") {
    const min = Number.isInteger(options.cidrMin) ? Math.max(1, Math.min(30, options.cidrMin)) : 8;
    const max = Number.isInteger(options.cidrMax) ? Math.max(min, Math.min(30, options.cidrMax)) : 30;
    return randomInt(min, max);
  }
  const selected = DIFFICULTY[mode] || DIFFICULTY.easy;
  return randomInt(selected.min, selected.max);
}

function difficultyForCidr(cidr) {
  if (cidr >= 24) return DIFFICULTY.easy;
  if (cidr >= 16) return DIFFICULTY.medium;
  return DIFFICULTY.hard;
}

function buildQuestions(info) {
  const common = {
    stem: `${info.ip}/${info.cidr} 주소가 주어졌을 때`,
    cidr: info.cidr
  };

  return [
    {
      id: "mask",
      title: "서브넷 마스크",
      prompt: "서브넷 마스크 값은?",
      answer: info.mask,
      type: "mask",
      hint: "예: 255.255.255.0",
      ...common
    },
    {
      id: "totalHosts",
      title: "전체 주소 수",
      prompt: "전체 주소 개수는?",
      answer: String(info.totalAddresses),
      type: "number",
      hint: "Network ID와 Broadcast 포함",
      ...common
    },
    {
      id: "usableHosts",
      title: "사용 가능 호스트 수",
      prompt: "Network ID, Broadcast, Gateway를 제외한 사용 가능 호스트 수는?",
      answer: String(info.usableHostCount),
      type: "number",
      hint: "",
      ...common
    },
    {
      id: "fullRange",
      title: "전체 주소 범위",
      prompt: "전체 주소 범위는?",
      answer: info.fullRange,
      type: "range",
      hint: "시작 주소와 끝 주소를 각각 입력",
      ...common
    },
    {
      id: "networkId",
      title: "Network ID",
      prompt: "Network ID는?",
      answer: info.networkId,
      type: "ip",
      hint: "첫 번째 주소",
      ...common
    },
    {
      id: "broadcast",
      title: "Broadcast",
      prompt: "Broadcast 주소는?",
      answer: info.broadcast,
      type: "ip",
      hint: "마지막 주소",
      ...common
    },
    {
      id: "gateway",
      title: "Gateway",
      prompt: "Gateway 주소는?",
      answer: info.gateway,
      type: "ip",
      hint: "마지막 사용 가능 주소",
      ...common
    },
    {
      id: "usableRange",
      title: "사용 가능 범위",
      prompt: "Network ID, Broadcast, Gateway를 제외한 사용 가능 범위는?",
      answer: info.usableRange,
      type: "range",
      hint: "시작 주소와 끝 주소를 각각 입력",
      ...common
    },
    {
      id: "groupCount",
      title: "전체 그룹 수",
      prompt: "전체 그룹 수는?",
      answer: String(info.groupCount),
      type: "number",
      hint: "",
      ...common
    },
    {
      id: "groupNumber",
      title: "현재 그룹 번호",
      prompt: "이 IP가 속한 그룹 번호는?",
      answer: String(info.groupNumber),
      type: "number",
      hint: "0번째 기준",
      ...common
    }
  ].map((question, index) => ({
    ...question,
    index,
    points: Math.round((QUESTION_WEIGHTS[question.id] * difficultyForCidr(info.cidr).factor) / 10) * 10
  }));
}

function createChallenge(mode = "easy", options = {}) {
  const cidr = pickCidr(mode, options);
  const info = subnetInfo(generateIp(cidr), cidr);
  // custom 모드의 실제 배율: cidr 범위 기반으로 자동 결정
  let factor = (DIFFICULTY[mode] || DIFFICULTY.easy).factor;
  if (mode === "custom" || mode === "random") {
    factor = difficultyForCidr(cidr).factor;
  }
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    mode,
    cidrMin: options.cidrMin,
    cidrMax: options.cidrMax,
    info,
    questions: buildQuestions(info)
  };
}

function extractIps(input) {
  return String(input).match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || [];
}

function normalizeAnswer(input, type) {
  const raw = String(input || "").trim();
  if (!raw) return "";

  if (type === "number") {
    const match = raw.replaceAll(",", "").match(/\d+/);
    return match ? String(Number(match[0])) : "";
  }

  if (type === "mask" || type === "ip") {
    const ips = extractIps(raw);
    return ips.length ? intToIp(ipToInt(ips[0])) : "";
  }

  if (type === "range") {
    const ips = extractIps(raw);
    if (ips.length < 2) return "";
    return `${intToIp(ipToInt(ips[0]))} ~ ${intToIp(ipToInt(ips[1]))}`;
  }

  return raw.toLowerCase();
}

function checkAnswer(question, input) {
  try {
    return normalizeAnswer(input, question.type) === normalizeAnswer(question.answer, question.type);
  } catch {
    return false;
  }
}

function scoreQuestion(question, isCorrect, elapsedMs) {
  if (!isCorrect) return 0;
  const elapsedSeconds = Math.max(0, elapsedMs / 1000);
  const speedBonus = Math.max(0, 1 - elapsedSeconds / 30) * 0.2;
  return Math.round((question.points * (1 + speedBonus)) / 10) * 10;
}

module.exports = {
  DIFFICULTY,
  buildQuestions,
  checkAnswer,
  cidrToMask,
  createChallenge,
  difficultyForCidr,
  ipToInt,
  intToIp,
  normalizeAnswer,
  scoreQuestion,
  subnetInfo
};
