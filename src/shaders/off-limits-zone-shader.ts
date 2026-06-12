const vertexShader = /* glsl */ `
    attribute vec3 vertex_position;
    attribute vec4 vertex_color;

    varying vec4 vColor;
    varying float vViewZ;

    uniform mat4 matrix_model;
    uniform mat4 matrix_view;
    uniform mat4 matrix_viewProjection;

    void main(void) {
        vec4 worldPos = matrix_model * vec4(vertex_position, 1.0);
        gl_Position = matrix_viewProjection * worldPos;
        vColor = vertex_color;
        vViewZ = (matrix_view * worldPos).z;
    }
`;

const fragmentShader = /* glsl */ `
    precision highp float;

    varying vec4 vColor;
    varying float vViewZ;

    uniform sampler2D zoneDepthTex;
    uniform vec4 camera_params; // matches src/shaders/splat-shader.ts usage

    void main(void) {
        vec2 uv = gl_FragCoord.xy / vec2(textureSize(zoneDepthTex, 0));
        vec4 d = texture2D(zoneDepthTex, uv);
        float transmittance = d.a;

        // Wall's normalized linear depth, using the SAME formula as the splat
        // depth-estimation shader so the two are directly comparable:
        //   normalizedDepth = (linearDepth - camera_params.z) / (camera_params.y - camera_params.z)
        // with linearDepth = -view.z.
        float wallNorm = (-vViewZ - camera_params.z) / (camera_params.y - camera_params.z);

        // Only occlude where splats actually exist in front (transmittance low
        // enough to be a real surface). Where there is no splat, always show.
        if (transmittance < 0.99) {
            float splatNorm = d.r / (1.0 - transmittance);
            if (wallNorm > splatNorm) {
                discard; // wall is behind the splat surface -> occluded
            }
        }

        gl_FragColor = vColor; // smooth alpha blend over composited splats behind
    }
`;

export { vertexShader, fragmentShader };
