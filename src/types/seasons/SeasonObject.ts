export interface SeasonObject {
    id?: number;
    user_id?: number;
    name?: string | null;
    start_date?: Date | null;
    end_date?: Date | null;
    is_challonge?: boolean | null;
    challonge_svg?: string | null;
    challonge_url?: string | null;
    is_toornament?: boolean | null;
    toornament_id?: string | null;
    toornament_logo?: string | null;
    discord_webhook_url?: string | null;
    discord_live_webhook_url?: string | null;
    discord_results_webhook_url?: string | null;
}