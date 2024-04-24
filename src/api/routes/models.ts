import _ from 'lodash';

export default {

    prefix: '/v1',

    get: {
        '/models': async () => {
            return {
                "data": [
                    {
                        "id": "concise",
                        "object": "model",
                        "owned_by": "metaso-free-api"
                    },
                    {
                        "id": "detail",
                        "object": "model",
                        "owned_by": "metaso-free-api"
                    },
                    {
                        "id": "research",
                        "object": "model",
                        "owned_by": "metaso-free-api"
                    },
                    {
                        "id": "concise-scholar",
                        "object": "model",
                        "owned_by": "metaso-free-api"
                    },
                    {
                        "id": "detail-scholar",
                        "object": "model",
                        "owned_by": "metaso-free-api"
                    },
                    {
                        "id": "research-scholar",
                        "object": "model",
                        "owned_by": "metaso-free-api"
                    }
                ]
            };
        }
    }
}