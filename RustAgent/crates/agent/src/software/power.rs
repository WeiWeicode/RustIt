//! A6:電池供電與計量網路時延後**下載**(P7-SOFTWARE-DESIGN §5.4、PLATFORM-PLAN §4.10 A6)。
//!
//! - 電池:`GetSystemPowerStatus` 的 `ACLineStatus = 0`(交流電離線);桌機沒有電池或無法判斷 → 不延後
//! - 計量網路:`INetworkCostManager::GetCost`(整台電腦)為 `Variable`、漫遊、已超過或接近資料上限 → 延後;
//!   `Fixed`(固定額度)但未接近上限不延後。API 失敗 → 不延後
//! - 指令 `ignore_power: true` 只略過電池判斷,**不略過計量網路**(流量費由使用者承擔)
//! - 每 [`CHECK_EVERY`] 重新檢查;最多延後 [`DEFER_MAX`](且不超過指令有效期限)→ `DEFERRED_TIMEOUT`
//! - 測試:`RUSTIT_TEST_POWER=battery` / `metered` 模擬(VM 沒有電池,§8.3 第 11 項);只能讓判斷更嚴,不能略過

use std::time::Duration;

/// 重新檢查間隔
pub const CHECK_EVERY: Duration = Duration::from_secs(300);
/// 延後上限(§9-9:4 小時)
pub const DEFER_MAX: Duration = Duration::from_secs(4 * 3600);

/// 目前的電源與網路狀態
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PowerState {
    pub on_battery: bool,
    pub metered: bool,
}

// NLM_CONNECTION_COST 旗標
const COST_VARIABLE: u32 = 0x4;
const COST_OVERDATALIMIT: u32 = 0x10000;
const COST_ROAMING: u32 = 0x40000;
const COST_APPROACHINGDATALIMIT: u32 = 0x80000;

/// 連線成本是否視為計量
pub fn metered(cost: u32) -> bool {
    cost & (COST_VARIABLE | COST_OVERDATALIMIT | COST_ROAMING | COST_APPROACHINGDATALIMIT) != 0
}

/// 延後原因;不延後回 None
pub fn defer_reason(s: PowerState, ignore_power: bool) -> Option<&'static str> {
    if s.metered {
        Some("計量網路")
    } else if s.on_battery && !ignore_power {
        Some("電池供電")
    } else {
        None
    }
}

/// 讀取目前狀態(阻塞:COM 呼叫;呼叫端放在阻塞執行緒)
#[cfg(windows)]
pub fn current() -> PowerState {
    let forced = std::env::var("RUSTIT_TEST_POWER").unwrap_or_default();
    PowerState {
        on_battery: forced == "battery" || on_battery(),
        metered: forced == "metered" || connection_cost().is_some_and(metered),
    }
}

#[cfg(windows)]
fn on_battery() -> bool {
    use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    let mut s = SYSTEM_POWER_STATUS::default();
    // SAFETY:輸出結構由呼叫端配置
    unsafe { GetSystemPowerStatus(&mut s) != 0 && s.ACLineStatus == 0 }
}

/// 整台電腦的連線成本;失敗回 None(視為不限制)
#[cfg(windows)]
fn connection_cost() -> Option<u32> {
    use windows::Win32::Networking::NetworkListManager::{INetworkCostManager, NetworkListManager};
    use windows::Win32::System::Com::{
        CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize,
    };
    // SAFETY:本執行緒初始化 COM(MTA),成功才配對 CoUninitialize
    let inited = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
    let cost = (|| {
        // SAFETY:COM 已初始化;介面在此閉包內使用並釋放
        unsafe {
            let mgr: INetworkCostManager =
                CoCreateInstance(&NetworkListManager, None, CLSCTX_ALL).ok()?;
            let mut cost = 0u32;
            mgr.GetCost(&mut cost, std::ptr::null()).ok()?;
            Some(cost)
        }
    })();
    if inited {
        // SAFETY:與上面成功的 CoInitializeEx 配對
        unsafe { CoUninitialize() };
    }
    cost
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cost_flags() {
        assert!(!metered(0x1), "Unrestricted");
        assert!(!metered(0x2), "Fixed、未接近上限");
        assert!(metered(0x4), "Variable");
        assert!(metered(0x2 | COST_APPROACHINGDATALIMIT));
        assert!(metered(0x1 | COST_ROAMING));
        assert!(metered(0x2 | COST_OVERDATALIMIT));
    }

    #[test]
    fn reasons() {
        let battery = PowerState {
            on_battery: true,
            metered: false,
        };
        let metered = PowerState {
            on_battery: false,
            metered: true,
        };
        assert_eq!(defer_reason(PowerState::default(), false), None);
        assert_eq!(defer_reason(battery, false), Some("電池供電"));
        assert_eq!(defer_reason(battery, true), None, "ignore_power 略過電池");
        assert_eq!(
            defer_reason(metered, true),
            Some("計量網路"),
            "ignore_power 不略過計量網路"
        );
    }

    #[cfg(windows)]
    #[test]
    fn reads_current_state_without_error() {
        // 只確認 API 呼叫不會失敗或當掉;結果依測試機而定
        let _ = current();
    }
}
