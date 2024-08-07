import { PassThrough } from "stream";
import _ from "lodash";
import { JSDOM } from "jsdom";
import axios, { AxiosResponse } from "axios";
import puppeteer from "puppeteer-core";
import type { Browser } from "puppeteer-core";

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import { createParser } from "eventsource-parser";
import logger from "@/lib/logger.ts";
import util from "@/lib/util.ts";

// 模型名称
const MODEL_NAME = "detail";
// 最大重试次数
const MAX_RETRY_COUNT = 3;
// 重试延迟
const RETRY_DELAY = 5000;
// 伪装headers
const FAKE_HEADERS = {
  Accept: "*/*",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Accept-Language": "zh-CN,zh;q=0.9",
  Origin: "https://metaso.cn",
  "Sec-Ch-Ua":
    '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
};
// 是否启用Token交换
let swapMode = false;

let browser: Browser = null;

async function requestStream(content: string, convId: string, token: string) {
  if (!browser) {
    browser = browser || await puppeteer.launch({
      headless: true,
      channel: util.isInDocker() ? undefined : "chrome",
      executablePath: util.isInDocker() ? "/usr/bin/chromium" : undefined,
      ignoreHTTPSErrors: true,
      userDataDir: 'tmp/browser',
      defaultViewport: null,
      args: [
        // 禁用沙箱
        "--no-sandbox",
        // 禁用UID沙箱
        "--disable-setuid-sandbox",
        // Windows下--single-process支持存在问题
        util.isLinux() ? "--single-process" : "--process-per-tab",
        // 如果共享内存/dev/shm比较小，可能导致浏览器无法启动，可以禁用它
        "--disable-dev-shm-usage",
        // 禁用扩展程序
        "--disable-extensions",
        // 隐藏滚动条
        "--hide-scrollbars",
        // 静音
        "--mute-audio",
        // 禁用GPU加速
        "--disable-gpu",
        "--disable-web-security"
      ]
    });
  }
  const page = await browser.newPage();
  await page.setUserAgent(FAKE_HEADERS['User-Agent']);
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false,
    });
    window.navigator.chrome = {
      runtime: {}
    };
    delete navigator.__proto__.webdriver;
  });
  const [uid, sid] = token.split("-");
  await page.setCacheEnabled(false);
  await page.setCookie({
    name: 'uid',
    value: uid,
    domain: ".metaso.cn"
  }, {
    name: 'sid',
    value: sid,
    domain: ".metaso.cn"
  });
  const client = await page.createCDPSession();
  await client.send("Fetch.enable", {
    patterns: [{
      urlPattern: "https://metaso.cn/api/searchV2*",
      requestStage: "Response"
    }]
  });
  const stream = new PassThrough();
  client.on("Fetch.requestPaused", async event => {
    const { requestId } = event;
    const result = await client.send("Fetch.takeResponseBodyAsStream", { requestId });
    const streamHandle = result.stream;
    if (!streamHandle)
      return;
    try {
      while (true) {
        const result = await client.send('IO.read', {
          handle: streamHandle,
          size: 256
        })
        if(!result)
          break;
        const { data, eof } = result;
        data && stream.write(data);
        if (eof)
          break;
      }
    } catch(err) {
      logger.error(err);
      stream.end('data: [DONE]\n\n');
    } finally {
      stream.end();
      await client.send('IO.close', { handle: streamHandle });
      await page.close();
    }
  });
  await page.goto(`https://metaso.cn/search/${convId}?q=${content}`);
  return stream;
}

/**
 * 获取meta-token
 *
 * @param token 认证Token
 */
async function acquireMetaToken(token: string, swapToken = false) {
  const result = await axios.get('https://metaso.cn/', {
    headers: {
      ...FAKE_HEADERS,
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-User": "?1",
      "Upgrade-Insecure-Requests": "1",
      Cookie: generateCookie(token),
    },
    timeout: 15000,
    validateStatus: () => true,
  });
  let html = result.data;
  if (
    result.status != 200 ||
    result.headers["content-type"].indexOf("text/html") == -1
  )
    throw new APIException(EX.API_REQUEST_FAILED, html);
  let regex = /<meta id="meta-token" content="([^"]*)"/;
  let match = html.match(regex);
  if (!match || !match[1])
    throw new APIException(EX.API_REQUEST_FAILED, "meta-token not found");
  let metaToken = match[1];
  if (swapToken) {
    let regex = /<script src="(https:\/\/static.metaso.cn\/_next\/static\/chunks\/9553-\w+\.js)"/;
    let match = result.data.match(regex);
    if (!match || !match[1])
      throw new APIException(EX.API_REQUEST_FAILED, "script url not found");
    const scriptResult = await axios.get(match[1], {
      headers: {
        ...FAKE_HEADERS,
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
        Cookie: generateCookie(token),
      }
    });
    if (scriptResult.status != 200 || scriptResult.headers["content-type"].indexOf("application/javascript") == -1)
      throw new APIException(EX.API_REQUEST_FAILED, "script invalid");
    regex = /function (mix|swap)\(\w+\)\{.+?\}/;
    match = scriptResult.data.match(regex);
    if (!match)
      throw new APIException(EX.API_REQUEST_FAILED, "script invalid");
    const swapFunction = match[0];
    const txLoginScriptResult = await axios.get('https://metaso.cn/txLogin.js');
    if (txLoginScriptResult.status != 200 || txLoginScriptResult.headers["content-type"].indexOf("application/javascript") == -1)
      throw new APIException(EX.API_REQUEST_FAILED, "script invalid");
    const txLoginScript = txLoginScriptResult.data;
    html += `<script>${txLoginScript}</script>`;
    const dom = new JSDOM(html, {
      url: "https://metaso.cn",
      runScripts: "dangerously"
    });
    metaToken = Function('window', `const {${Object.keys(dom.window).filter(v => v != 'window' && !v.includes('-')).join(',')}} = window;return ${swapFunction}`)(dom.window)(metaToken);
  }
  return metaToken;
}

/**
 * 生成Cookie
 *
 * @param token 认证Token
 */
function generateCookie(token: string) {
  const [uid, sid] = token.split("-");
  return `uid=${uid}; sid=${sid}; `;
}

/**
 * 创建会话
 *
 * 创建临时的会话用于对话补全
 *
 * @param token 认证Token
 */
async function createConversation(name: string, model: string, engineType: string, token: string) {
  const metaToken = await acquireMetaToken(token);
  const result = await axios.post(
    "https://metaso.cn/api/session",
    {
      question: name,
      mode: model,
      engineType,
      scholarSearchDomain: "all",
    },
    {
      headers: {
        Cookie: generateCookie(token),
        Token: metaToken,
        "Is-Mini-Webview": "0",
        ...FAKE_HEADERS,
      },
      timeout: 15000,
      validateStatus: () => true,
    }
  );
  const {
    data: { id: convId },
  } = checkResult(result);
  return convId;
}

/**
 * 同步对话补全
 *
 * @param model 模型名称
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param token 认证Token
 * @param useSearch 是否开启联网搜索
 * @param retryCount 重试次数
 */
async function createCompletion(
  model = MODEL_NAME,
  messages: any[],
  token: string,
  tempature = 0.6,
  retryCount = 0
) {
  return (async () => {
    logger.info(messages);

    const {
      model: _model,
      content,
      engineType
    } = messagesPrepare(model, messages, tempature);

    // 创建会话
    const convId = await createConversation(content, _model, engineType, token);
    
    // 请求流
    // const metaToken = await acquireMetaToken(token, swapMode);
    // const result = await axios.get(`https://metaso.cn/api/searchV2`, {
    //   params: {
    //     sessionId: convId,
    //     question: content,
    //     lang: 'zh',
    //     mode: _model,
    //     url: `https://metaso.cn/search/${convId}?newSearch=true&q=${content}`,
    //     enableMix: 'true',
    //     scholarSearchDomain: 'all',
    //     expectedCurrentSessionSearchCount: '1',
    //     'is-mini-webview': '0',
    //     token: metaToken
    //   },
    //   headers: {
    //     Cookie: generateCookie(token),
    //     ...FAKE_HEADERS,
    //     Accept: "text/event-stream",
    //   },
    //   // 300秒超时
    //   timeout: 300000,
    //   validateStatus: () => true,
    //   responseType: "stream",
    // }
    // );

    // 请求流
    const stream = await requestStream(content, convId, token);

    const streamStartTime = util.timestamp();
    // 接收流为输出文本
    const answer = await receiveStream(model, convId, stream);
    logger.success(
      `Stream has completed transfer ${util.timestamp() - streamStartTime}ms`
    );

    return answer;
  })().catch((err) => {
    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`Stream response error: ${err.message}`);
      logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
      return (async () => {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        return createCompletion(
          model,
          messages,
          token,
          tempature,
          retryCount + 1
        );
      })();
    }
    throw err;
  });
}

/**
 * 流式对话补全
 *
 * @param model 模型名称
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param token 认证Token
 * @param useSearch 是否开启联网搜索
 * @param retryCount 重试次数
 */
async function createCompletionStream(
  model = MODEL_NAME,
  messages: any[],
  token: string,
  tempature = 0.6,
  retryCount = 0
) {
  return (async () => {
    logger.info(messages);

    const {
      model: _model,
      content,
      engineType
    } = messagesPrepare(model, messages, tempature);

    // 创建会话
    const convId = await createConversation(content, _model, engineType, token);

    // // 请求流
    // const metaToken = await acquireMetaToken(token, swapMode);
    // const result = await axios.get(`https://metaso.cn/api/searchV2`, {
    //   params: {
    //     sessionId: convId,
    //     question: content,
    //     lang: 'zh',
    //     mode: _model,
    //     url: `https://metaso.cn/search/${convId}?newSearch=true&q=${content}`,
    //     enableMix: 'true',
    //     scholarSearchDomain: 'all',
    //     expectedCurrentSessionSearchCount: '1',
    //     'is-mini-webview': '0',
    //     token: metaToken
    //   },
    //   headers: {
    //     Cookie: generateCookie(token),
    //     ...FAKE_HEADERS,
    //     Accept: "text/event-stream",
    //   },
    //   // 300秒超时
    //   timeout: 300000,
    //   validateStatus: () => true,
    //   responseType: "stream",
    // }
    // );
    // 请求流
    const stream = await requestStream(content, convId, token);

    const streamStartTime = util.timestamp();
    // 创建转换流将消息格式转换为gpt兼容格式
    return createTransStream(model, convId, stream, () => {
      logger.success(
        `Stream has completed transfer ${util.timestamp() - streamStartTime}ms`
      );
    });
  })().catch((err) => {
    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`Stream response error: ${err.message}`);
      logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
      return (async () => {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        return createCompletionStream(
          model,
          messages,
          token,
          tempature,
          retryCount + 1
        );
      })();
    }
    throw err;
  });
}

/**
 * 消息预处理
 * 
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 */
function messagesPrepare(model: string, messages: any[], tempature: number) {
  let latestMessage = messages[messages.length - 1];
  if (!latestMessage)
    throw new APIException(EX.API_TEST);
  let content = latestMessage.content;
  let engineType = "";
  ([model, engineType = ""] = model.split('-'));
  // 如果模型名称未遵守预设则检查指令是否存在，如果都没有再以温度为准
  if (!["concise", "detail", "research", "concise"].includes(model)) {
    if (content.indexOf('简洁搜索') != -1) {
      model = "concise";
      content = content.replace(/简洁搜索[:|：]?/g, '');
    }
    else if (content.indexOf('深入搜索') != -1) {
      model = "detail";
      content = content.replace(/深入搜索[:|：]?/g, '');
    }
    else if (content.indexOf('研究搜索') != -1) {
      model = "research";
      content = content.replace(/研究搜索[:|：]?/g, '');
    }
    else {
      if (tempature < 0.4)
        model = "concise";
      else if (tempature >= 0.4 && tempature < 0.7)
        model = "detail";
      else if (tempature >= 0.7)
        model = "research";
      else
        model = MODEL_NAME;
    }
  }
  if (/^学术/.test(content)) {
    engineType = "scholar";
    content = content.replace(/^学术/, '');
  }
  if (engineType && !["scholar"].includes(engineType))
    engineType = "";
  const isScholar = engineType == "scholar";
  logger.info(`\n选用模式：${({
    'concise': isScholar ? '学术-简洁' : '简洁',
    'detail': isScholar ? '学术-深入' : '深入',
    'research': isScholar ? '学术-研究' : '研究'
  })[model]}\n搜索内容：${content}`);
  return {
    model,
    engineType,
    content
  };
}

/**
 * 去除内容的索引标签
 * 
 * @param content 内容
 */
function removeIndexLabel(content: string) {
  return content.replace(/\[\[\d+\]\]/g, '');
}

/**
 * 检查请求结果
 *
 * @param result 结果
 */
function checkResult(result: AxiosResponse) {
  if (!result.data) return null;
  const { errCode, errMsg } = result.data;
  if (!_.isFinite(errCode) || errCode == 0) return result.data;
  throw new APIException(EX.API_REQUEST_FAILED, errMsg);
}

/**
 * 从流接收完整的消息内容
 *
 * @param model 模型名称
 * @param convId 会话ID
 * @param stream 消息流
 */
async function receiveStream(model: string, convId: string, stream: any) {
  return new Promise((resolve, reject) => {
    // 消息初始化
    const data = {
      id: convId,
      model,
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      created: util.unixTimestamp(),
    };
    const parser = createParser((event) => {
      try {
        if (event.type !== "event") return;
        if (event.data == "[DONE]") return;
        // 解析JSON
        const result = _.attempt(() => JSON.parse(event.data));
        if (_.isError(result)) {
          if (event.data.indexOf('TOO_MANY_REQUESTS') != -1)
            swapMode = !swapMode;
          throw new Error(`Stream response invalid: ${event.data}`);
        }
        if (result.type == "append-text")
          data.choices[0].message.content += removeIndexLabel(result.text);
        else if (result.type == "error")
          data.choices[0].message.content += `[${result.code}]${result.msg}`;
      } catch (err) {
        logger.error(err);
        reject(err);
      }
    });
    // 将流数据喂给SSE转换器
    stream.on("data", (buffer) => parser.feed(buffer.toString()));
    stream.once("error", (err) => reject(err));
    stream.once("close", () => resolve(data));
  });
}

/**
 * 创建转换流
 *
 * 将流格式转换为gpt兼容流格式
 *
 * @param model 模型名称
 * @param convId 会话ID
 * @param stream 消息流
 * @param endCallback 传输结束回调
 */
function createTransStream(
  model: string,
  convId: string,
  stream: any,
  endCallback?: Function
) {
  // 消息创建时间
  const created = util.unixTimestamp();
  // 创建转换流
  const transStream = new PassThrough();
  !transStream.closed &&
    transStream.write(
      `data: ${JSON.stringify({
        id: convId,
        model,
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "" },
            finish_reason: null,
          },
        ],
        created,
      })}\n\n`
    );
  const parser = createParser((event) => {
    try {
      if (event.type !== "event") return;
      if (event.data == "[DONE]") {
        const data = `data: ${JSON.stringify({
          id: convId,
          model,
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          created,
        })}\n\n`;
        !transStream.closed && transStream.write(data);
        !transStream.closed && transStream.end("data: [DONE]\n\n");
        endCallback && endCallback();
        return;
      }
      // 解析JSON
      const result = _.attempt(() => JSON.parse(event.data));
      if (_.isError(result)) {
        if (event.data.indexOf('TOO_MANY_REQUESTS') != -1)
          swapMode = !swapMode;
        throw new Error(`Stream response invalid: ${event.data}`);
      }
      if (result.type == "append-text") {
        const data = `data: ${JSON.stringify({
          id: convId,
          model,
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: removeIndexLabel(result.text) },
              finish_reason: null,
            },
          ],
          created,
        })}\n\n`;
        !transStream.closed && transStream.write(data);
      }
      else if (result.type == "error") {
        const data = `data: ${JSON.stringify({
          id: convId,
          model,
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: `[${result.code}]${result.msg}` },
              finish_reason: null,
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          created,
        })}\n\n`;
        !transStream.closed && transStream.write(data);
        return;
      }
    } catch (err) {
      logger.error(err);
      !transStream.closed && transStream.end("\n\n");
    }
  });
  // 将流数据喂给SSE转换器
  stream.on("data", (buffer) => parser.feed(buffer.toString()));
  stream.once(
    "error",
    () => !transStream.closed && transStream.end("data: [DONE]\n\n")
  );
  stream.once(
    "close",
    () => !transStream.closed && transStream.end("data: [DONE]\n\n")
  );
  return transStream;
}

/**
 * Token切分
 *
 * @param authorization 认证字符串
 */
function tokenSplit(authorization: string) {
  return authorization.replace("Bearer ", "").split(",");
}

/**
 * 获取Token存活状态
 */
async function getTokenLiveStatus(token: string) {
  const result = await axios.get(
    "https://metaso.cn/api/my-info",
    {
      headers: {
        Cookie: generateCookie(token),
        "Is-Mini-Webview": "0",
        ...FAKE_HEADERS,
      },
      timeout: 15000,
      validateStatus: () => true,
    }
  );

  try {
    const {
      data: { user },
    } = checkResult(result);
    return !!user;
  }
  catch (err) {
    console.log(err);
    return false;
  }
}

export default {
  createConversation,
  createCompletion,
  createCompletionStream,
  getTokenLiveStatus,
  tokenSplit,
};
