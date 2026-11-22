# masks.py: an events file -> what to blur: [first frame, last frame, x0,y0,x1,y1, kind]
import json
STEP=10
def masks(tag,mid,kinds=('subtitle','label'),W=1920,H=1080):
    import os
    if os.path.exists(f'{tag}/scan/{mid}.masks.json'): return json.load(open(f'{tag}/scan/{mid}.masks.json'))
    out=[]
    for t in json.load(open(f'{tag}/scan/{mid}.events.json')):
        if t['kind'] not in kinds: continue
        a=t['before']+1 if t['before'] is not None else t['f0']-(STEP-1)
        b=t['after']-1 if t['after'] is not None else t['f1']+STEP-1
        x0,y0,x1,y1=t['box']; h=y1-y0; py=max(6,0.12*h); px=0.3*h
        out.append([a,b,max(0,int(x0-px)),max(0,int(y0-py)),min(W,int(x1+px)),min(H,int(y1+py)),t['kind']])
    return out
def at(ms,f): return [m for m in ms if m[0]<=f<=m[1]]
def blur(img,boxes):
    import cv2
    for _,_,x0,y0,x1,y1,_ in boxes:
        if x1>x0 and y1>y0: img[y0:y1,x0:x1]=cv2.GaussianBlur(img[y0:y1,x0:x1],(0,0),28)
    return img
