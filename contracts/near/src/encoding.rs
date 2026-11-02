use crate::{config::Network, state::Offer};

fn text(output: &mut Vec<u8>, value: &str) {
    output.extend_from_slice(&(value.len() as u32).to_le_bytes());
    output.extend_from_slice(value.as_bytes());
}

pub fn encode_offer(offer: &Offer) -> Vec<u8> {
    let mut output = Vec::new();
    text(&mut output, "kanso:offer");
    output.extend_from_slice(&2_u16.to_le_bytes());
    text(&mut output, &offer.deployment_id);
    output.push(match offer.network {
        Network::Sandbox => 0,
        Network::Testnet => 1,
    });
    for value in [
        &offer.offer_id,
        &offer.pool_id,
        offer.borrower.as_str(),
        offer.payout_account.as_str(),
    ] {
        text(&mut output, value);
    }
    output.extend_from_slice(&offer.policy_version.to_le_bytes());
    output.extend_from_slice(&offer.principal_atomic.0.to_le_bytes());
    output.extend_from_slice(&offer.apr_bps.to_le_bytes());
    output.extend_from_slice(&offer.duration_seconds.to_le_bytes());
    output.extend_from_slice(&offer.origination_fee_atomic.0.to_le_bytes());
    output.extend_from_slice(&offer.expires_at.to_le_bytes());
    output.extend_from_slice(&offer.setup_deadline.to_le_bytes());
    output.extend_from_slice(&offer.min_price_atomic.0.to_le_bytes());
    output.extend_from_slice(&offer.max_price_atomic.0.to_le_bytes());
    output.extend_from_slice(&(offer.legs.len() as u32).to_le_bytes());
    for leg in &offer.legs {
        text(&mut output, &leg.asset_id);
        match &leg.custody {
            crate::state::Custody::Near => output.push(0),
            crate::state::Custody::Remote {
                chain_id,
                manifest_version,
                lock_id,
                source_owner,
                release_recipient,
                min_price_atomic,
                max_price_atomic,
            } => {
                output.push(1);
                text(&mut output, chain_id);
                output.extend_from_slice(&manifest_version.to_le_bytes());
                output.extend_from_slice(&min_price_atomic.0.to_le_bytes());
                output.extend_from_slice(&max_price_atomic.0.to_le_bytes());
                for value in [lock_id, source_owner, release_recipient] {
                    output.extend_from_slice(&(value.len() as u32).to_le_bytes());
                    output.extend_from_slice(value);
                }
            }
        }
        text(&mut output, &leg.leg_id);
        text(&mut output, leg.owner.as_str());
        output.extend_from_slice(&leg.amount_atomic.0.to_le_bytes());
        text(&mut output, leg.release_recipient.as_str());
    }
    output
}
