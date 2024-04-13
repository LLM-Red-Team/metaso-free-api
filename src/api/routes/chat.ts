import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import chat from '@/api/controllers/chat.ts';
import util from '@/lib/util.ts';

export default {

    prefix: '/v1/chat',

    post: {

        '/completions': async (request: Request) => {
            request
                .validate('body.model', v => _.isUndefined(v) || _.isString(v))
                .validate('body.messages', _.isArray)
                .validate('body.tempature', v => _.isUndefined(v) || _.isNumber(v))
                .validate('headers.authorization', _.isString)
            // token切分
            const tokens = chat.tokenSplit(request.headers.authorization);
            // 随机挑选一个token
            const token = _.sample(tokens);
            const { model, messages, stream, tempature } = request.body;;
            if (stream) {
                try {
                    const stream = await chat.createCompletionStream(model, messages, token, tempature);
                    return new Response(stream, {
                        type: "text/event-stream"
                    });
                }
                catch(err) {
                    return new Response(Buffer.from(`data: ${JSON.stringify({
                        id: "",
                        model,
                        object: "chat.completion.chunk",
                        choices: [
                          {
                            index: 0,
                            delta: { role: "assistant", content: err.message },
                            finish_reason: "stop",
                          },
                        ],
                        created: util.unixTimestamp(),
                      })}\n\ndata: [DONE]\n\n`), {
                        type: "text/event-stream"
                    });
                }
            }
            else
                return await chat.createCompletion(model, messages, token, tempature);
        }

    }

}