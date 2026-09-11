const vertexShader = /* wgsl */`
attribute vertex_position: vec3f;
attribute vertex_color: vec4f;

uniform matrix_model: mat4x4f;
uniform matrix_view: mat4x4f;
uniform matrix_viewProjection: mat4x4f;

varying vColor: vec4f;
varying vViewZ: f32;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let worldPos = uniform.matrix_model * vec4f(input.vertex_position, 1.0);
    output.position = uniform.matrix_viewProjection * worldPos;
    output.vColor = input.vertex_color;
    output.vViewZ = (uniform.matrix_view * worldPos).z;
    return output;
}
`;

const fragmentShader = /* wgsl */`
var zoneDepthTex: texture_2d<f32>;

// [1/farClip, farClip, nearClip, projection] -- published by camera.ts as its own
// device-scope uniform. v3 sets the engine's cameraParams as a material
// parameter on the projected splat material, so it is not visible here.
uniform zoneCameraParams: vec4f;

varying vColor: vec4f;
varying vViewZ: f32;

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;

    let texel = vec2i(pcPosition.xy);
    let d = textureLoad(zoneDepthTex, texel, 0);
    let transmittance = d.a;

    // Wall's normalized linear depth, using the SAME formula as the splat
    // depth-estimation shader so the two are directly comparable:
    //   normalizedDepth = (linearDepth - nearClip) / (farClip - nearClip)
    // with linearDepth = -view.z.
    let wallNorm = (-input.vViewZ - uniform.zoneCameraParams.z) / (uniform.zoneCameraParams.y - uniform.zoneCameraParams.z);

    // Only occlude where splats actually exist in front (transmittance low
    // enough to be a real surface). Where there is no splat, always show.
    if (transmittance < 0.99) {
        let splatNorm = d.r / (1.0 - transmittance);
        if (wallNorm > splatNorm) {
            discard; // wall is behind the splat surface -> occluded
        }
    }

    output.color = input.vColor; // smooth alpha blend over composited splats behind
    return output;
}
`;

export { vertexShader, fragmentShader };
