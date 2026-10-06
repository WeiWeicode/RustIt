/** 錯誤(BACKEND-GUIDE.md §5.3):自訂代碼以系統代碼 ITA_ 開頭;不可使用 Gateway 專用代碼 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** SQL Server 無法寫入:Agent 留在本機暫存重試(INTEGRATION-PLAN §3.1) */
export const storageUnavailable = () => new AppError(503, 'ITA_STORAGE_UNAVAILABLE', '資料庫暫時無法使用,請稍後重試');
