export interface PythResponse {
    binary: {
        encoding: string;
        data: string[];
    };
    parsed: {
        id: string;
        price: {
            price: string;
            conf: string;
            expo: number;
            publish_time: number;
        }
        ema_price: {
            price: string;
            conf: string;
            expo: number;
            publish_time: number;
        };
        metadata: {
            slot: number;
            proof_available_time: number;
            prev_publish_time: number;
        };
    }[];
}