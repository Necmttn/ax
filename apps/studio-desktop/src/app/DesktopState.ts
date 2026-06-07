import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export interface DesktopStateShape {
    readonly backendReady: Ref.Ref<boolean>;
    readonly quitting: Ref.Ref<boolean>;
}

export class DesktopState extends Context.Service<DesktopState, DesktopStateShape>()(
    "@ax/studio-desktop/app/DesktopState",
) {}

export const layer = Layer.effect(
    DesktopState,
    Effect.gen(function* () {
        return DesktopState.of({
            backendReady: yield* Ref.make(false),
            quitting: yield* Ref.make(false),
        });
    }),
);
