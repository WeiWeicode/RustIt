//! 蒐集時降低優先權（PLATFORM-PLAN §4.10 A6）：執行緒進入 Windows 背景模式，CPU 與 I/O 都以低優先權執行，
//! 不影響使用者正在操作的程式。WMI 的實際查詢在 WmiPrvSE.exe 行程內，不受本設定影響。

use windows_sys::Win32::System::Threading::{
    GetCurrentThread, SetThreadPriority, THREAD_MODE_BACKGROUND_BEGIN, THREAD_MODE_BACKGROUND_END,
};

/// 進入背景模式；離開範圍時恢復。呼叫端的執行緒可能被重複使用（tokio spawn_blocking），所以一定要恢復。
pub(crate) struct BackgroundMode {
    entered: bool,
}

impl BackgroundMode {
    pub(crate) fn enter() -> Self {
        // SAFETY:GetCurrentThread 回傳目前執行緒的虛擬控制代碼，不需關閉；失敗時（例如已在背景模式）只是不降優先權
        let entered =
            unsafe { SetThreadPriority(GetCurrentThread(), THREAD_MODE_BACKGROUND_BEGIN) } != 0;
        Self { entered }
    }
}

impl Drop for BackgroundMode {
    fn drop(&mut self) {
        if self.entered {
            // SAFETY:同上;只恢復本物件進入的背景模式
            unsafe { SetThreadPriority(GetCurrentThread(), THREAD_MODE_BACKGROUND_END) };
        }
    }
}
